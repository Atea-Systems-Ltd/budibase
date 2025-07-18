import * as triggers from "../../automations/triggers"
import { sdk as coreSdk } from "@budibase/shared-core"
import { DocumentType } from "../../db/utils"
import { updateTestHistory } from "../../automations/utils"
import { withTestFlag } from "../../utilities/redis"
import {
  context,
  cache,
  events,
  db as dbCore,
  HTTPError,
} from "@budibase/backend-core"
import { automations, features } from "@budibase/pro"
import {
  App,
  Automation,
  AutomationActionStepId,
  UserCtx,
  DeleteAutomationResponse,
  FetchAutomationResponse,
  GetAutomationTriggerDefinitionsResponse,
  GetAutomationStepDefinitionsResponse,
  GetAutomationActionDefinitionsResponse,
  FindAutomationResponse,
  UpdateAutomationRequest,
  UpdateAutomationResponse,
  CreateAutomationRequest,
  CreateAutomationResponse,
  SearchAutomationLogsRequest,
  SearchAutomationLogsResponse,
  ClearAutomationLogRequest,
  ClearAutomationLogResponse,
  TriggerAutomationRequest,
  TriggerAutomationResponse,
  TestAutomationRequest,
  TestAutomationResponse,
  Table,
} from "@budibase/types"
import { getActionDefinitions as actionDefs } from "../../automations/actions"
import sdk from "../../sdk"
import { builderSocket } from "../../websockets"
import env from "../../environment"

/*************************
 *                       *
 *   BUILDER FUNCTIONS   *
 *                       *
 *************************/

export async function create(
  ctx: UserCtx<CreateAutomationRequest, CreateAutomationResponse>
) {
  let automation = ctx.request.body
  automation.appId = ctx.appId

  // call through to update if already exists
  if (automation._id && automation._rev) {
    await update(ctx)
    return
  }

  const createdAutomation = await sdk.automations.create(automation)

  ctx.body = {
    message: "Automation created successfully",
    automation: createdAutomation,
  }
  builderSocket?.emitAutomationUpdate(ctx, automation)
}

export async function update(
  ctx: UserCtx<UpdateAutomationRequest, UpdateAutomationResponse>
) {
  let automation = ctx.request.body
  automation.appId = ctx.appId

  // Call through to create if it doesn't exist
  if (!automation._id || !automation._rev) {
    await create(ctx)
    return
  }

  const updatedAutomation = await sdk.automations.update(automation)

  ctx.body = {
    message: `Automation ${automation._id} updated successfully.`,
    automation: updatedAutomation,
  }
  builderSocket?.emitAutomationUpdate(ctx, automation)
}

export async function fetch(ctx: UserCtx<void, FetchAutomationResponse>) {
  const automations = await sdk.automations.fetch()
  ctx.body = { automations }
}

export async function find(ctx: UserCtx<void, FindAutomationResponse>) {
  ctx.body = await sdk.automations.get(ctx.params.id)
}

export async function destroy(ctx: UserCtx<void, DeleteAutomationResponse>) {
  const automationId = ctx.params.id

  const automation = await sdk.automations.get(ctx.params.id)
  if (coreSdk.automations.isRowAction(automation)) {
    ctx.throw("Row actions automations cannot be deleted", 422)
  }

  ctx.body = await sdk.automations.remove(automationId, ctx.params.rev)
  builderSocket?.emitAutomationDeletion(ctx, automationId)
}

export async function logSearch(
  ctx: UserCtx<SearchAutomationLogsRequest, SearchAutomationLogsResponse>
) {
  ctx.body = await automations.logs.logSearch(ctx.request.body)
}

export async function clearLogError(
  ctx: UserCtx<ClearAutomationLogRequest, ClearAutomationLogResponse>
) {
  const { automationId, appId } = ctx.request.body
  await context.doInAppContext(appId, async () => {
    const db = context.getProdAppDB()
    const metadata = await db.get<App>(DocumentType.APP_METADATA)
    if (!automationId) {
      delete metadata.automationErrors
    } else if (
      metadata.automationErrors &&
      metadata.automationErrors[automationId]
    ) {
      delete metadata.automationErrors[automationId]
    }
    await db.put(metadata)
    await cache.app.invalidateAppMetadata(metadata.appId, metadata)
    ctx.body = { message: `Error logs cleared.` }
  })
}

export async function getActionList(
  ctx: UserCtx<void, GetAutomationActionDefinitionsResponse>
) {
  ctx.body = await actionDefs()
}

export async function getTriggerList(
  ctx: UserCtx<void, GetAutomationTriggerDefinitionsResponse>
) {
  ctx.body = triggers.TRIGGER_DEFINITIONS
}

export async function getDefinitionList(
  ctx: UserCtx<void, GetAutomationStepDefinitionsResponse>
) {
  ctx.body = {
    trigger: triggers.TRIGGER_DEFINITIONS,
    action: await actionDefs(),
  }
}

/*********************
 *                   *
 *   API FUNCTIONS   *
 *                   *
 *********************/

export async function trigger(
  ctx: UserCtx<TriggerAutomationRequest, TriggerAutomationResponse>
) {
  const db = context.getAppDB()
  let automation = await db.get<Automation>(ctx.params.id)

  let hasCollectStep = sdk.automations.utils.checkForCollectStep(automation)
  if (hasCollectStep && (await features.isSyncAutomationsEnabled())) {
    try {
      const response = await triggers.externalTrigger(
        automation,
        {
          fields: ctx.request.body.fields,
          user: sdk.users.getUserContextBindings(ctx.user),
          timeout:
            ctx.request.body.timeout * 1000 || env.AUTOMATION_THREAD_TIMEOUT,
        },
        { getResponses: true }
      )

      if (!("steps" in response)) {
        ctx.throw(400, "Unable to collect response")
      }

      let collectedValue = response.steps.find(
        step => step.stepId === AutomationActionStepId.COLLECT
      )
      ctx.body = collectedValue?.outputs
    } catch (err: any) {
      if (err.message) {
        ctx.throw(400, err.message)
      } else {
        throw err
      }
    }
  } else {
    if (ctx.appId && !dbCore.isProdAppID(ctx.appId)) {
      ctx.throw(400, "Only apps in production support this endpoint")
    }
    await triggers.externalTrigger(automation, {
      ...ctx.request.body,
      appId: ctx.appId,
      user: sdk.users.getUserContextBindings(ctx.user),
    })
    ctx.body = {
      message: `Automation ${automation._id} has been triggered.`,
    }
  }
}

function prepareTestInput(input: TestAutomationRequest) {
  // prepare the test parameters
  if (input.id && input.row) {
    input.row._id = input.id
  }
  if (input.revision && input.row) {
    input.row._rev = input.revision
  }
  return input
}

export async function test(
  ctx: UserCtx<TestAutomationRequest, TestAutomationResponse>
) {
  const db = context.getAppDB()
  const automation = await db.tryGet<Automation>(ctx.params.id)
  if (!automation) {
    ctx.throw(404, `Automation ${ctx.params.id} not found`)
  }

  const { request, appId } = ctx
  const { body } = request

  let table: Table | undefined
  if (coreSdk.automations.isRowAction(automation) && body.row?.tableId) {
    table = await sdk.tables.getTable(body.row?.tableId)
    if (!table) {
      throw new HTTPError("Table not found", 404)
    }
  }

  ctx.body = await withTestFlag(automation._id!, async () => {
    const occurredAt = new Date().getTime()
    await updateTestHistory(appId, automation, { ...body, occurredAt })
    const input = prepareTestInput(body)
    const user = sdk.users.getUserContextBindings(ctx.user)
    return await triggers.externalTrigger(
      automation,
      { ...{ ...input, ...(table ? { table } : {}) }, appId, user },
      { getResponses: true }
    )
  })

  await events.automation.tested(automation)
}
