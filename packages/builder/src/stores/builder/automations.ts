import { derived, get, readable, Readable } from "svelte/store"
import { API } from "@/api"
import { cloneDeep } from "lodash/fp"
import { generate } from "shortid"
import { createHistoryStore, HistoryStore } from "@/stores/builder/history"
import { licensing, organisation, environment } from "@/stores/portal"
import { tables, appStore, permissions } from "@/stores/builder"
import { notifications } from "@budibase/bbui"
import {
  getEnvironmentBindings,
  migrateReferencesInObject,
  getUserBindings,
  getSettingBindings,
  getSchemaForDatasourcePlus,
} from "@/dataBinding"
import {
  AutomationTriggerStepId,
  AutomationEventType,
  AutomationActionStepId,
  Automation,
  AutomationStep,
  Table,
  Branch,
  AutomationTrigger,
  AutomationStatus,
  UILogicalOperator,
  EmptyFilterOption,
  AutomationIOType,
  BlockPath,
  BlockRef,
  BlockDefinitions,
  isBranchStep,
  isTrigger,
  isRowUpdateTrigger,
  isRowSaveTrigger,
  isAppTrigger,
  BranchStep,
  GetAutomationTriggerDefinitionsResponse,
  GetAutomationActionDefinitionsResponse,
  AppSelfResponse,
  TestAutomationResponse,
  isAutomationResults,
  RowActionTriggerOutputs,
  WebhookTriggerOutputs,
  AutomationCustomIOType,
  AutomationStepInputs,
  AutomationIOProps,
  AutomationTriggerInputs,
  AppActionTrigger,
  RowActionTriggerInputs,
  RowActionTrigger,
  EnrichedBinding,
  BlockDefinitionTypes,
  AutomationTriggerResultOutputs,
  AutomationTriggerResult,
  AutomationStepType,
  PermissionLevel,
  isDidNotTriggerResponse,
  AutomationResults,
  isActionStep,
} from "@budibase/types"
import { ActionStepID, TriggerStepID } from "@/constants/backend/automations"
import { FIELDS as COLUMNS } from "@/constants/backend"
import { sdk } from "@budibase/shared-core"
import { rowActions } from "./rowActions"
import { getNewStepName } from "@/helpers/automations/nameHelpers"
import { QueryUtils, Utils } from "@budibase/frontend-core"
import { BudiStore, DerivedBudiStore } from "@/stores/BudiStore"
import {
  DataMode,
  FilterableRowTriggers,
  RowTriggers,
  type AutomationState,
  type DerivedAutomationState,
  type FormUpdate,
  type StepInputs,
} from "@/types/automations"
import { TableNames } from "@/constants"

const initialAutomationState: AutomationState = {
  automations: [],
  showTestModal: false,
  blockDefinitions: {
    TRIGGER: {},
    CREATABLE_TRIGGER: {},
    ACTION: {},
  },
  selectedAutomationId: null,
}

const getFinalDefinitions = (
  triggers: GetAutomationTriggerDefinitionsResponse,
  actions: GetAutomationActionDefinitionsResponse
): BlockDefinitions => {
  const creatable: Partial<GetAutomationTriggerDefinitionsResponse> = {}
  for (const [key, trigger] of Object.entries(triggers)) {
    if (key === AutomationTriggerStepId.ROW_ACTION) {
      continue
    }
    if (trigger.deprecated === true) {
      continue
    }
    creatable[key as keyof GetAutomationTriggerDefinitionsResponse] = trigger
  }
  return {
    TRIGGER: triggers,
    CREATABLE_TRIGGER: creatable,
    ACTION: actions,
  }
}

const automationActions = (store: AutomationStore) => ({
  /**
   * @param {Automation} auto
   * @param {BlockRef} blockRef
   * @returns
   */
  getBlockByRef: (
    auto?: Automation,
    blockRef?: BlockRef
  ): AutomationStep | AutomationTrigger | undefined => {
    if (!blockRef || !auto) {
      return
    }

    const target = automationStore.actions
      .getPathSteps(blockRef.pathTo, auto)
      .at(-1)

    return target as AutomationStep | AutomationTrigger | undefined
  },

  /**
   * Build and retrieve the block input properties from a Trigger/Step
   * @param {AutomationStep | AutomationTrigger} block
   * @returns
   */
  getInputData: (block?: AutomationStep | AutomationTrigger): StepInputs => {
    if (!block) {
      console.error("Block required to generate step input data")
      return
    }
    let newInputData

    if (isTrigger(block)) {
      const triggerInputs: AutomationTriggerInputs<typeof block.stepId> =
        block.inputs
      newInputData = cloneDeep(triggerInputs)
    } else if (isActionStep(block)) {
      const blockInputs: AutomationStepInputs<typeof block.stepId> =
        block.inputs
      newInputData = cloneDeep(blockInputs)
    }

    store.actions.setDefaultEnumValues(
      newInputData,
      block.schema?.inputs?.properties
    )

    return newInputData
  },

  /**
   * Parses through the provided prop schema updates any enum
   * values with the first option if no value is currently set.
   *
   * @param inputData
   */
  setDefaultEnumValues: (
    inputData:
      | AutomationStepInputs<AutomationActionStepId>
      | AutomationTriggerInputs<AutomationTriggerStepId>,
    inputPropSchema: AutomationIOProps
  ) => {
    // In order to alter enum fields you must make the inputData indexable
    const idxInput = inputData as Record<string, unknown>

    const schemaProperties = Object.entries(inputPropSchema)

    for (const [key, value] of schemaProperties) {
      if (
        value.type === AutomationIOType.STRING &&
        value.enum &&
        !idxInput[key]
      ) {
        idxInput[key] = value.enum[0]
      }
    }
  },

  /**
   * Fetches the app user context used for live evaluation
   * This matches the context used on the server. Only expose
   * valid schema values used in bindings
   * @returns {AppSelfResponse | null}
   */
  initAppSelf: async (): Promise<AppSelfResponse | null> => {
    // Fetch and update the app self if it hasn't been set
    const appSelfResponse: AppSelfResponse | null = await API.fetchSelf()

    if (!appSelfResponse) {
      return appSelfResponse
    }
    const { schema }: { schema: Record<string, any> } =
      getSchemaForDatasourcePlus(TableNames.USERS, null)

    const keys = [...Object.keys(schema), "globalId"] as Array<
      keyof AppSelfResponse
    >

    // Reduce the fields to include the same elements as seen in the bindings
    const serverUser = keys.reduce((acc, key) => {
      if (key in appSelfResponse) {
        acc[key] = appSelfResponse[key]
      }
      return acc
    }, {} as Partial<AppSelfResponse>)

    store.update(state => ({
      ...state,
      appSelf: serverUser,
    }))

    return serverUser
  },
  /**
   * Move a given block from one location on the tree to another.
   *
   * @param {Object} sourcePath path to the block to be moved
   * @param {Object} destPath the destinationPart
   * @param {Object} automation the automaton to be mutated
   */
  moveBlock: async (
    sourcePath: BlockPath[],
    destPath: BlockPath[],
    automation: Automation
  ) => {
    // The last part of the source node address, containing the id.
    const pathSource = sourcePath.at(-1)

    // The last part of the destination node address, containing the id.
    const pathEnd = destPath.at(-1)

    // Check if dragging a step into its own drag zone
    const isOwnDragzone = pathSource?.id === pathEnd?.id

    // Check if dragging the first branch step into the branch node drag zone
    const isFirstBranchStep =
      pathEnd?.branchStepId &&
      pathEnd.branchIdx === pathSource?.branchIdx &&
      pathSource?.stepIdx === 0

    // If dragging into an area that will not affect the tree structure
    // Ignore the drag and drop.
    if (isOwnDragzone || isFirstBranchStep) {
      return
    }

    // Use core delete to remove and return the deleted block
    // from the automation
    const { deleted, newAutomation } = store.actions.deleteBlock(
      sourcePath,
      automation
    )

    // Traverse again as deleting the node from its original location
    // will redefine all proceding node locations
    const newRefs: Record<string, any> = {}
    store.actions.traverse(newRefs, newAutomation)

    let finalPath
    // If dropping in a branch-step dropzone you need to find
    // the updated parent step route then add the branch details again
    if (pathEnd?.branchStepId) {
      const branchStepRef = newRefs[pathEnd.branchStepId]
      finalPath = branchStepRef.pathTo
      finalPath.push(pathEnd)
    } else {
      // Place the target 1 after the drop
      if (pathEnd?.id) {
        finalPath = newRefs[pathEnd.id].pathTo
      }
      finalPath.at(-1).stepIdx += 1
    }

    // Uses the updated tree refs to resolve the new position
    // for the moved element.
    const updated = store.actions.updateStep(
      finalPath,
      newAutomation,
      deleted,
      true
    )

    try {
      await store.actions.save(updated)
    } catch (e) {
      notifications.error("Error moving automation block")
      console.error("Error moving automation block ", e)
    }
  },
  /**
   * Core delete function that will delete the node at the provided
   * location. Loops require 2 deletes so the function returns an array.
   * The passed in automation is not mutated
   *
   * @param {*} pathTo the tree path to the target node
   * @param {*} automation the automation to alter.
   * @returns {Object} contains the deleted nodes and new updated automation
   */
  deleteBlock: (pathTo: Array<BlockPath>, automation: Automation) => {
    let newAutomation = cloneDeep(automation)

    const steps = [
      newAutomation.definition.trigger,
      ...newAutomation.definition.steps,
    ]

    let cache: any
    pathTo.forEach((path, pathIdx, array) => {
      const final = pathIdx === array.length - 1
      const { stepIdx, branchIdx } = path

      const deleteCore = (steps: AutomationStep[], idx: number) => {
        const targetBlock = steps[idx]
        // By default, include the id of the target block
        const idsToDelete = [targetBlock.id]
        const blocksDeleted: AutomationStep[] = []

        // If deleting a looped block, ensure all related block references are
        // collated beforehand. Delete can then be handled atomically
        const loopSteps: Record<string, string> = {}
        steps.forEach(child => {
          const { blockToLoop, id: loopBlockId } = child
          if (blockToLoop) {
            // The loop block > the block it loops
            loopSteps[blockToLoop] = loopBlockId
          }
        })

        // Check if there is a related loop block to remove
        const loopStep = loopSteps[targetBlock.id]
        if (loopStep) {
          idsToDelete.push(loopStep)
        }

        // Purge all ids related to the block being deleted
        for (let i = steps.length - 1; i >= 0; i--) {
          if (idsToDelete.includes(steps[i].id)) {
            const [deletedBlock] = steps.splice(i, 1)
            blocksDeleted.unshift(deletedBlock)
          }
        }

        return { deleted: blocksDeleted, newAutomation }
      }

      if (!cache) {
        // If the path history is empty and on the final step
        // delete the specified target
        if (final) {
          cache = deleteCore(
            newAutomation.definition.steps,
            stepIdx > 0 ? stepIdx - 1 : 0
          )
        } else {
          // Return the root node
          cache = steps[stepIdx]
        }
        return
      }

      if (Number.isInteger(branchIdx)) {
        const branchId = cache.inputs.branches[branchIdx].id
        const children = cache.inputs.children[branchId]
        const currentBlock = children[stepIdx]

        if (final) {
          cache = deleteCore(children, stepIdx)
        } else {
          cache = currentBlock
        }
      }
    })

    // should be 1-2 blocks in an array
    return cache
  },
  /**
   * Build metadata for the automation tree. Store the path and
   * note any loop information used when rendering
   *
   * @param {Object} block
   * @param {Array<Object>} pathTo
   */
  registerBlock: (
    blocks: Record<string, any>,
    block: AutomationStep | AutomationTrigger,
    pathTo: Array<BlockPath>,
    terminating: boolean
  ) => {
    blocks[block.id] = {
      ...(blocks[block.id] || {}),
      pathTo,
      terminating: terminating || false,
      ...(block.blockToLoop ? { blockToLoop: block.blockToLoop } : {}),
    }

    // If this is a loop block, add a reference to the block being looped
    if (block.blockToLoop) {
      blocks[block.blockToLoop] = {
        ...(blocks[block.blockToLoop] || {}),
        looped: block.id,
      }
    }
  },

  /**
   * Build a sequential list of all steps on the step path provided
   *
   * @param {Array<Object>} pathWay e.g. [{stepIdx:2},{branchIdx:0, stepIdx:2},...]
   * @returns {Array<AutomationStep | AutomationTrigger>} all steps encountered on the provided path
   */
  getPathSteps: (
    pathWay: Array<BlockPath>,
    automation: Automation
  ): Array<AutomationStep | AutomationTrigger> => {
    // Base Steps, including trigger
    const steps = [
      automation.definition.trigger,
      ...automation.definition.steps,
    ]

    let result: (AutomationStep | AutomationTrigger)[] = []
    pathWay.forEach(path => {
      const { stepIdx, branchIdx } = path
      let last: AutomationStep | AutomationTrigger | undefined = result.length
        ? result[result.length - 1]
        : undefined
      if (!result.length) {
        // Preceeding steps.
        result = steps.slice(0, stepIdx + 1)
        return
      }

      if (Number.isInteger(branchIdx)) {
        const branch = last as BranchStep
        const branchId = branch.inputs?.branches[branchIdx].id
        const children = branch.inputs?.children?.[branchId] ?? []

        const stepChildren = children.slice(0, stepIdx + 1)
        // Preceeding steps.
        result = result.concat(stepChildren)
      }
    })
    return result
  },

  /**
   * Take an updated step and replace it in the specified location
   * on the automation. If `insert` is set to true, the supplied block/s
   * will be inserted instead.
   *
   * @param {Array<Object>} pathWay the full path to the tree node and the step
   * @param {Object} automation the automation to be mutated
   * @param {Object} update the block to replace
   * @param {Boolean} insert defaults to false
   * @returns
   */
  updateStep: (
    pathWay: Array<BlockPath>,
    automation: Automation,
    update: AutomationStep | AutomationTrigger,
    insert = false
  ) => {
    let newAutomation = cloneDeep(automation)

    const finalise = (
      dest: AutomationStep[],
      idx: number,
      update: AutomationStep | AutomationTrigger
    ) => {
      dest.splice(
        idx,
        insert ? 0 : Array.isArray(update) ? update.length : 1,
        ...(Array.isArray(update) ? update : [update])
      )
    }

    let cache: any = null
    pathWay.forEach((path, idx, array) => {
      const { stepIdx, branchIdx } = path
      let final = idx === array.length - 1

      if (!cache) {
        // Trigger offset
        let idx = Math.max(stepIdx - 1, 0)
        if (final) {
          finalise(newAutomation.definition.steps, idx, update)
          return
        }
        cache = newAutomation.definition.steps[idx]
      }

      if (Number.isInteger(branchIdx)) {
        const branchId = cache.inputs.branches[branchIdx].id
        const children = cache.inputs.children[branchId]
        if (final) {
          finalise(children, stepIdx, update)
        } else {
          cache = children[stepIdx]
        }
      }
    })

    return newAutomation
  },

  /**
   * If the current license covers Environment variables,
   * all environment variables will be output as bindings
   *
   * @returns {Array<Object>} all available environment bindings
   */
  buildEnvironmentBindings: () => {
    if (get(licensing).environmentVariablesEnabled) {
      return getEnvironmentBindings().map(binding => {
        return {
          ...binding,
          display: {
            ...binding.display,
            rank: 98,
          },
        }
      })
    }
    return []
  },

  /**
   * Get user bindings
   *
   * @returns {Array<Object>} all available user bindings
   */
  buildUserBindings: () => {
    return getUserBindings().map((binding: any) => {
      return {
        ...binding,
        category: "User",
        display: {
          ...binding.display,
          rank: 98,
        },
      }
    })
  },

  /**
   * Get settings bindings
   *
   * @returns {Array<Object>} all available settings bindings
   */
  buildSettingBindings: () => {
    return getSettingBindings().map(binding => {
      return {
        ...binding,
        display: {
          ...binding.display,
          rank: 98,
        },
      }
    })
  },
  /**
   * Take the supplied step id and aggregate all bindings for every
   * step preceding it.
   *
   * @param {string} id the step id of the target
   * @param {Automation} automation the automation to be searched
   * @returns {Array<EnrichedBinding>} all bindings on the path to this step
   */
  getPathBindings: (id?: string, automation?: Automation) => {
    if (!automation || !id) {
      console.error("getPathBindings: requires a valid step id and automation")
      return []
    }
    const block = get(selectedAutomation)?.blockRefs[id]

    return store.actions.getAvailableBindings(block, automation)
  },

  /**
   * Takes the provided automation and traverses all possible paths.
   * References to all nodes/steps encountered on the way are stored
   * in state under 'blocks'. These references are used to store tree related
   * metadata like the tree path or whether the node is terminating.
   *
   * @param {Object} automation
   */
  traverse: (blockRefs: Record<string, any>, automation: Automation) => {
    let blocks: (AutomationStep | AutomationTrigger)[] = []
    if (!automation || !blockRefs) {
      return
    }
    if (automation.definition?.trigger) {
      blocks.push(automation.definition.trigger)
    }
    blocks = blocks.concat(automation.definition.steps || [])

    const treeTraverse = (
      block: AutomationStep | AutomationTrigger,
      pathTo: Array<any> | null,
      stepIdx: number,
      branchIdx: number | null,
      terminating: boolean
    ) => {
      const pathToCurrentNode = [
        ...(pathTo || []),
        {
          ...(Number.isInteger(branchIdx) ? { branchIdx } : {}),
          stepIdx,
          id: block.id,
        },
      ]

      if (isBranchStep(block)) {
        const branches = block.inputs?.branches || []
        const children = block.inputs?.children || {}

        branches.forEach((branch, bIdx) => {
          children[branch.id]?.forEach(
            (bBlock: AutomationStep, sIdx: number, array: AutomationStep[]) => {
              const ended = array.length - 1 === sIdx
              treeTraverse(bBlock, pathToCurrentNode, sIdx, bIdx, ended)
            }
          )
        })

        terminating = terminating && !branches.length
      }

      store.actions.registerBlock(
        blockRefs,
        block,
        pathToCurrentNode,
        terminating
      )
    }

    // Traverse the entire tree.
    blocks.forEach((block, idx, array) => {
      treeTraverse(block, null, idx, null, array.length - 1 === idx)
    })
    return blockRefs
  },

  getAvailableBindings: (
    block: any,
    automation: Automation
  ): EnrichedBinding[] => {
    if (!block || !automation?.definition) {
      return []
    }

    // Registered blocks
    const blocks = get(selectedAutomation)?.blockRefs

    // Get all preceeding steps, including the trigger
    // Filter out the target step as we don't want to include itself
    const pathSteps = store.actions
      .getPathSteps(block.pathTo, automation)
      .slice(0, -1)

    // Current step will always be the last step of the path
    const currentBlock = store.actions
      .getPathSteps(block.pathTo, automation)
      .at(-1)

    // Extract all outputs from all previous steps as available bindings
    let bindings: any[] = []
    const addBinding = (
      name: string,
      schema: any,
      icon: string,
      idx: number,
      isLoopBlock: boolean,
      pathBlock: AutomationStep | AutomationTrigger,
      bindingName: string
    ) => {
      if (!name) return

      const runtimeBinding = store.actions.determineRuntimeBinding(
        name,
        idx,
        isLoopBlock,
        automation,
        currentBlock,
        pathSteps
      )

      // Skip binding if its invalid
      if (!runtimeBinding) {
        return
      }

      const readableBinding = store.actions.determineReadableBinding(
        name,
        pathBlock
      )

      const categoryName = store.actions.determineCategoryName(
        idx,
        isLoopBlock,
        bindingName,
        loopBlockCount
      )

      const isStep = !isLoopBlock && idx !== 0
      const defaultReadable =
        bindingName && isStep ? `steps.${bindingName}.${name}` : runtimeBinding

      // Check if the schema matches any column types.
      const column = Object.values(COLUMNS).find(
        col =>
          col.type === schema.type &&
          ("subtype" in col ? col.subtype === schema.subtype : true)
      )

      // Automation types and column types can collide e.g. "array"
      // Exclude where necessary
      const ignoreColumnType = schema.customType === AutomationCustomIOType.ROWS

      // Shown in the bindable menus
      const displayType = ignoreColumnType ? schema.type : column?.name

      bindings.push({
        readableBinding: readableBinding || defaultReadable,
        runtimeBinding,
        type: schema.type,
        description: schema.description,
        icon,
        category: categoryName,
        display: {
          type: displayType,
          name,
          rank: isLoopBlock ? idx + 1 : idx - loopBlockCount,
        },
      })
    }

    let loopBlockCount = 0

    for (let blockIdx = 0; blockIdx < pathSteps.length; blockIdx++) {
      const pathBlock = pathSteps[blockIdx]
      const bindingName =
        automation.definition.stepNames?.[pathBlock.id] || pathBlock.name

      let schema = cloneDeep(pathBlock?.schema?.outputs?.properties) ?? {}
      let isLoopBlock = false
      if (pathBlock.blockToLoop) {
        isLoopBlock =
          pathBlock.stepId === ActionStepID.LOOP &&
          pathBlock.blockToLoop in blocks
      }

      if (isLoopBlock && loopBlockCount == 0) {
        schema = {
          currentItem: {
            type: AutomationIOType.STRING,
            description: "the item currently being executed",
          },
        }
      }

      const icon = isTrigger(pathBlock)
        ? pathBlock.icon
        : isLoopBlock
          ? "Reuse"
          : pathBlock.icon

      if (blockIdx === 0 && isTrigger(pathBlock)) {
        if (isRowUpdateTrigger(pathBlock) || isRowSaveTrigger(pathBlock)) {
          const rowTrigger = pathBlock as AutomationTrigger

          const inputs = rowTrigger.inputs as Exclude<
            AutomationTriggerInputs<typeof pathBlock.stepId>,
            void
          >
          let table: any = get(tables).list.find(
            (table: Table) => table._id === inputs.tableId
          )

          for (const key in table?.schema) {
            schema[key] = {
              type: table.schema[key].type,
              subtype: table.schema[key].subtype,
            }
          }
          delete schema.row
        } else if (isAppTrigger(pathBlock)) {
          const appActionTrigger = pathBlock as AppActionTrigger
          const inputs = appActionTrigger.inputs as Exclude<
            AutomationTriggerInputs<typeof pathBlock.stepId>,
            void
          >
          schema = Object.fromEntries(
            Object.keys(inputs.fields || {}).map(key => [
              key,
              { type: inputs.fields?.[key] },
            ])
          )
        }
      }

      // Add the loop outputs to a looped block
      if (blocks[pathBlock.id]?.looped) {
        loopBlockCount++

        const loopBlockId = blocks[pathBlock.id].looped
        const loopBlock = pathSteps.find(step => step.id === loopBlockId)
        if (loopBlock) {
          schema = cloneDeep(loopBlock.schema?.outputs?.properties)
        } else {
          console.error("Loop block missing.")
        }
      }

      Object.entries(schema).forEach(([name, value]) => {
        addBinding(
          name,
          value,
          icon,
          blockIdx,
          isLoopBlock,
          pathBlock,
          bindingName
        )
      })
    }

    // Remove loop items
    if (!block.looped) {
      bindings = bindings.filter(x => !x.readableBinding.includes("loop"))
    }
    return bindings
  },

  determineReadableBinding: (
    name: string,
    block: AutomationStep | AutomationTrigger
  ) => {
    const rowTriggers: string[] = [
      TriggerStepID.ROW_UPDATED,
      TriggerStepID.ROW_SAVED,
      TriggerStepID.ROW_DELETED,
      TriggerStepID.ROW_ACTION,
    ]

    const isTrigger = block.type === AutomationStepType.TRIGGER
    const isAppTrigger = block.stepId === AutomationTriggerStepId.APP
    const isRowTrigger = rowTriggers.includes(block.stepId)

    let readableBinding = ""
    if (isTrigger) {
      if (isAppTrigger) {
        readableBinding = `trigger.fields.${name}`
      } else if (isRowTrigger) {
        let noRowKeywordBindings = ["id", "revision", "oldRow"]
        readableBinding = noRowKeywordBindings.includes(name)
          ? `trigger.${name}`
          : `trigger.row.${name}`
      } else {
        readableBinding = `trigger.${name}`
      }
    }

    return readableBinding
  },

  determineRuntimeBinding: (
    name: string,
    idx: number,
    isLoopBlock: boolean,
    automation: Automation,
    currentBlock: AutomationStep | AutomationTrigger | undefined,
    pathSteps: (AutomationStep | AutomationTrigger)[]
  ) => {
    let runtimeName: string

    // Legacy support for EXECUTE_SCRIPT steps
    const isJSScript =
      currentBlock?.stepId === AutomationActionStepId.EXECUTE_SCRIPT

    /* Begin special cases for generating custom schemas based on triggers */
    if (
      idx === 0 &&
      automation.definition.trigger?.event === AutomationEventType.APP_TRIGGER
    ) {
      return isJSScript
        ? `trigger.fields["${name}"]`
        : `trigger.fields.[${name}]`
    }

    if (
      idx === 0 &&
      (automation.definition.trigger?.event ===
        AutomationEventType.ROW_UPDATE ||
        automation.definition.trigger?.event === AutomationEventType.ROW_SAVE)
    ) {
      let noRowKeywordBindings = ["id", "revision", "oldRow"]
      if (!noRowKeywordBindings.includes(name)) {
        return isJSScript ? `trigger.row["${name}"]` : `trigger.row.[${name}]`
      }
    }
    /* End special cases for generating custom schemas based on triggers */

    if (isLoopBlock) {
      runtimeName = `loop.${name}`
    } else if (idx === 0) {
      runtimeName = `trigger.[${name}]`
    } else if (isJSScript) {
      const stepId = pathSteps[idx].id
      if (!stepId) {
        notifications.error("Error generating binding: Step ID not found.")
        return
      }
      runtimeName = `steps["${stepId}"].${name}`
    } else {
      const stepId = pathSteps[idx].id
      if (!stepId) {
        notifications.error("Error generating binding: Step ID not found.")
        return
      }
      runtimeName = `steps.${stepId}.${name}`
    }

    return runtimeName
  },

  determineCategoryName: (
    idx: number,
    isLoopBlock: boolean,
    bindingName: string | undefined,
    loopBlockCount: number
  ) => {
    if (idx === 0) return "Trigger outputs"
    if (isLoopBlock) return "Loop Outputs"
    return bindingName
      ? `${bindingName} outputs`
      : `Step ${idx - loopBlockCount} outputs`
  },

  processBlockInputs: async (
    block: AutomationStep | AutomationTrigger,
    data: FormUpdate
  ): Promise<Automation | undefined> => {
    // Create new modified block
    let newBlock: { inputs: any } & (AutomationStep | AutomationTrigger) = {
      ...block,
      inputs: {
        ...block.inputs,
        ...data,
      },
    }

    // Remove any nullish or empty string values
    Object.keys(newBlock.inputs).forEach(key => {
      const val = newBlock.inputs[key]
      if (val == null || val === "") {
        delete newBlock.inputs[key]
      }
    })

    // Create new modified automation
    const automation = get(selectedAutomation)?.data
    if (!automation) {
      console.error("Could not process input blocks. No selected automation")
      return
    }
    const newAutomation = store.actions.getUpdatedDefinition(
      automation,
      newBlock
    )

    // Don't save if no changes were made
    if (JSON.stringify(newAutomation) === JSON.stringify(automation)) {
      return
    }

    return newAutomation
  },

  updateBlockInputs: async (
    block: AutomationStep,
    data: Record<string, any>
  ) => {
    const newAutomation = await store.actions.processBlockInputs(block, data)
    if (!newAutomation) {
      return
    }
    await store.actions.save(newAutomation)
  },

  test: async (automation: Automation, testData: any) => {
    let result: TestAutomationResponse
    try {
      result = await API.testAutomation(automation._id!, testData)
    } catch (err: any) {
      const message = err.message || err.status || JSON.stringify(err)
      throw `Automation test failed - ${message}`
    }
    store.update(state => {
      state.testResults = result
      return state
    })
  },

  getUpdatedDefinition: (
    automation: Automation,
    block: AutomationStep | AutomationTrigger
  ): Automation => {
    let newAutomation: Automation
    if (automation.definition.trigger?.id === block.id) {
      newAutomation = cloneDeep(automation)
      newAutomation.definition.trigger = block as AutomationTrigger
    } else {
      const pathToStep = get(selectedAutomation)!.blockRefs[block.id].pathTo
      newAutomation = store.actions.updateStep(pathToStep, automation, block)
    }
    return newAutomation
  },

  getLogs: async ({
    automationId,
    startDate,
    status,
    page,
  }: {
    automationId?: string
    startDate?: string
    status?: AutomationStatus
    page?: string
  } = {}) => {
    return await API.getAutomationLogs({
      automationId,
      startDate,
      status,
      page,
    })
  },

  clearLogErrors: async ({
    automationId,
    appId,
  }: {
    automationId: string
    appId: string
  }) => {
    if (!automationId || !appId) {
      throw new Error("automationId and appId are required")
    }
    return await API.clearAutomationLogErrors(automationId, appId)
  },

  addTestDataToAutomation: (data: any) => {
    let newAutomation = cloneDeep(get(selectedAutomation)?.data)
    if (!newAutomation) {
      return newAutomation
    }
    newAutomation.testData = {
      ...newAutomation.testData,
      ...data,
    }
    return newAutomation
  },

  constructBlock: (
    type: BlockDefinitionTypes,
    stepId: string,
    blockDefinition: any
  ) => {
    const newStep = {
      ...blockDefinition,
      inputs: blockDefinition.inputs || {},
      stepId,
      type,
      id: generate(),
    }
    const newName = getNewStepName(get(selectedAutomation)?.data, newStep)
    newStep.name = newName
    return newStep
  },

  /**
   * Generate a new branch block for adding to the automation
   * There are a minimum of 2 empty branches by default.
   *
   * @returns {Object} - a default branch block
   */
  generateBranchBlock: () => {
    const branchDefinition = get(store).blockDefinitions.ACTION.BRANCH
    return store.actions.constructBlock(
      BlockDefinitionTypes.ACTION,
      "BRANCH",
      branchDefinition
    )
  },

  /**
   * Take a newly constructed block and insert it in the automation tree
   * at the specified location.
   *
   * @param {Object} block the new block
   * @param {Array<Object>} pathWay location of insert point
   */
  addBlockToAutomation: async (
    block: AutomationStep,
    pathWay: Array<BlockPath>
  ) => {
    const automation = get(selectedAutomation)?.data
    if (!automation) {
      return
    }
    let newAutomation = cloneDeep(automation)

    const steps = [
      newAutomation.definition.trigger,
      ...newAutomation.definition.steps,
    ]

    let cache:
      | AutomationStep
      | AutomationTrigger
      | AutomationStep[]
      | undefined = undefined

    pathWay.forEach((path, pathIdx, array) => {
      const { stepIdx, branchIdx } = path
      const final = pathIdx === array.length - 1

      const insertBlock = (steps: AutomationStep[], stepIdx: number) => {
        const isBranchNode = !Number.isInteger(stepIdx)
        const insertIdx =
          block.blockToLoop || isBranchNode ? stepIdx : stepIdx + 1
        steps.splice(insertIdx, 0, block)
      }

      if (!cache) {
        if (final) {
          insertBlock(newAutomation.definition.steps, stepIdx - 1)
          cache = block
        } else {
          cache = steps[stepIdx]
        }
        return
      }
      if (
        Number.isInteger(branchIdx) &&
        !Array.isArray(cache) &&
        isBranchStep(cache)
      ) {
        const branchId = cache.inputs.branches[branchIdx].id
        const children = cache.inputs.children?.[branchId] || []

        if (final) {
          insertBlock(children, stepIdx)
          cache = children
        } else {
          cache = children[stepIdx]
        }
      }
    })

    try {
      await store.actions.save(newAutomation)
    } catch (e) {
      notifications.error("Error adding automation block")
      console.error("Automation adding block ", e)
    }
  },

  /**
   * Generate empty condition config
   * Used on initialisation and reset of a condition.
   *
   * @returns {Object} contains a condition and conditionUI entry.
   */
  generateDefaultConditions: () => {
    const baseConditionUI = {
      logicalOperator: UILogicalOperator.ALL,
      onEmptyFilter: EmptyFilterOption.RETURN_NONE,
      groups: [],
    }
    return {
      condition: QueryUtils.buildQuery(baseConditionUI),
      conditionUI: baseConditionUI,
    }
  },

  /**
   * Generates a new branch in the tree at the given location.
   * All steps below the path, if any, are added to a new default branch
   * 2 branch nodes are created by default.
   *
   * @param {Array<Object>} path - the insertion point on the tree.
   * @param {Object} automation - the target automation to update.
   */
  branchAutomation: async (path: Array<any>, automation: Automation) => {
    const insertPoint = path.at(-1)
    let newAutomation = cloneDeep(automation)
    let cache: any
    let atRoot = false

    // Generate a default empty branch
    const createBranch = (name: string) => {
      return {
        name,
        ...store.actions.generateDefaultConditions(),
        id: generate(),
      }
    }

    path.forEach((path, pathIdx, array) => {
      const { stepIdx, branchIdx } = path
      const final = pathIdx === array.length - 1

      if (!cache) {
        if (final) {
          cache = newAutomation.definition.steps
          atRoot = true
        } else {
          // Initial trigger offset
          cache = newAutomation.definition.steps[stepIdx - 1]
        }
      }

      if (Number.isInteger(branchIdx)) {
        const branchId = cache.inputs.branches[branchIdx].id
        const children = cache.inputs.children[branchId]

        // return all step siblings
        cache = final ? children : children[stepIdx]
      }
    })

    // Trigger offset when inserting
    const rootIdx = Math.max(insertPoint.stepIdx - 1, 0)
    const insertIdx = atRoot ? rootIdx : insertPoint.stepIdx

    // Check if the branch point is a on a branch step
    // Create an empty branch instead and append it
    if (cache[insertIdx]?.stepId == "BRANCH") {
      let branches = cache[insertIdx].inputs.branches
      const branchEntry = createBranch(`Branch ${branches.length + 1}`)

      // Splice the branch entry in
      branches.splice(branches.length, 0, branchEntry)

      // Add default children entry for the new branch
      cache[insertIdx].inputs.children[branchEntry.id] = []

      try {
        await store.actions.save(newAutomation)
      } catch (e) {
        notifications.error("Error adding branch to automation")
        console.error("Error adding automation branch", e)
      }
      return
    }

    // Creating a new branch block
    const newBranch = store.actions.generateBranchBlock()

    // Default branch node count is 2. Build 2 default entries
    newBranch.inputs.branches = Array.from({ length: 2 }).map((_, idx) => {
      return createBranch(`Branch ${idx + 1}`)
    })

    // Init the branch children. Shift all steps following the new branch step
    // into the 0th branch.
    newBranch.inputs.children = newBranch.inputs.branches.reduce(
      (acc: Record<string, AutomationStep[]>, branch: Branch, idx: number) => {
        acc[branch.id] = idx == 0 ? cache.slice(insertIdx + 1) : []
        return acc
      },
      {}
    )

    // Purge siblings that were branched
    cache.splice(insertIdx + 1)

    // Add the new branch to the end.
    cache.push(newBranch)

    try {
      await store.actions.save(newAutomation)
    } catch (e) {
      notifications.error("Error adding branch to automation")
      console.error("Error adding automation branch", e)
    }
  },

  /**
   * Take a block and move the provided branch to the left
   *
   * @param {Array<Object>} pathTo
   * @param {Object} automation
   * @param {Object} block
   */
  branchLeft: async (
    pathTo: Array<any>,
    automation: Automation,
    block: BranchStep
  ) => {
    const update = store.actions.shiftBranch(pathTo, block)
    if (update) {
      const updatedAuto = store.actions.updateStep(
        pathTo.slice(0, -1),
        automation,
        update
      )
      await store.actions.save(updatedAuto)
    }
  },

  /**
   * Take a block and move the provided branch right
   *
   * @param {Array<Object>} pathTo
   * @param {Object} automation
   * @param {Object} block
   */
  branchRight: async (
    pathTo: Array<BlockPath>,
    automation: Automation,
    block: BranchStep
  ) => {
    const update = store.actions.shiftBranch(pathTo, block, 1)
    if (update) {
      const updatedAuto = store.actions.updateStep(
        pathTo.slice(0, -1),
        automation,
        update
      )
      await store.actions.save(updatedAuto)
    }
  },

  /**
   * Shift swap a branch with its immediate neighbour.
   * @param {Array<Object>} pathTo - address of the branch to be moved.
   * @param {Object} block - the step the branch belongs to
   * @param {Number} direction - the direction of the swap. Defaults to -1 for left, add 1 for right
   * @returns
   */
  shiftBranch: (pathTo: Array<any>, block: BranchStep, direction = -1) => {
    let newBlock = cloneDeep(block)
    const branchPath = pathTo.at(-1)
    const targetIdx = branchPath.branchIdx

    if (!newBlock.inputs.branches[targetIdx + direction]) {
      console.error("Invalid index")
      return
    }

    let [neighbour] = newBlock.inputs.branches.splice(targetIdx + direction, 1)
    newBlock.inputs.branches.splice(targetIdx, 0, neighbour)
    return newBlock
  },

  /**
   * Delete a branch at the given path
   * When branch count reaches 1, the branch children are removed
   * and replace the parent branch step at its index.
   *
   * @param {Array<Object>} path
   * @param {Array<Object>} automation
   */
  deleteBranch: async (path: Array<any>, automation: Automation) => {
    let newAutomation = cloneDeep(automation)
    let cache: any = []

    path.forEach((path, pathIdx, array) => {
      const { stepIdx, branchIdx } = path
      const final = pathIdx === array.length - 1

      // The first poi
      if (!cache.length) {
        if (final) {
          cache = newAutomation.definition.steps
          return
        }
        // Trigger offset
        cache = [
          {
            node: newAutomation.definition.steps[stepIdx - 1],
            context: newAutomation.definition.steps,
          },
        ]
      }

      const current = cache.at(-1)

      if (Number.isInteger(branchIdx)) {
        // data.inputs.branches.length
        const branchId = current.node.inputs.branches[branchIdx].id
        const children = current.node.inputs.children[branchId]

        if (final) {
          // 2 is the minimum amount of nodes on a branch
          const minBranches = current.node.inputs.branches.length == 2

          // Delete the target branch and its contents.
          current.node.inputs.branches.splice(branchIdx, 1)
          delete current.node.inputs.children[branchId]

          // If deleting with only 2 branches, the entire branch step
          // will be deleted, with its contents placed onto the parent.
          if (minBranches) {
            const lastBranchId = current.node.inputs.branches[0].id
            const lastBranchContent = current.node.inputs.children[lastBranchId]

            // Take the remaining branch and push all children onto the context
            const parentContext = cache.at(-1).context

            // Remove the branch node.
            parentContext.pop()

            // Splice in the remaining branch content into the parent.
            parentContext.splice(parentContext.length, 0, ...lastBranchContent)
          }

          return
        }

        cache.push({ node: children[stepIdx], context: children })
      }
    })

    try {
      await store.actions.save(newAutomation)
    } catch (e) {
      notifications.error("Error deleting automation branch")
      console.error("Error deleting automation branch", e)
    }
  },

  saveAutomationName: async (blockId: string, name: string) => {
    const automation = get(selectedAutomation)?.data
    let newAutomation = cloneDeep(automation)
    if (!newAutomation) {
      return
    }

    const newName = name.trim()
    newAutomation.definition.stepNames = {
      ...newAutomation.definition.stepNames,
      [blockId]: newName,
    }

    await store.actions.save(newAutomation)
  },

  deleteAutomationName: async (blockId: string) => {
    const automation = get(selectedAutomation)?.data
    let newAutomation = cloneDeep(automation)
    if (!automation || !newAutomation) {
      return
    }
    if (newAutomation?.definition.stepNames) {
      delete newAutomation.definition.stepNames[blockId]
    }

    await store.actions.save(newAutomation)
  },

  /**
   * Delete the block at a given path and save.
   * Any related blocks, like loops, are purged at the same time
   *
   * @param {Array<Object>} pathTo the path to the target node
   */
  deleteAutomationBlock: async (pathTo: Array<BlockPath>) => {
    const automation = get(selectedAutomation)?.data
    if (!automation) {
      return
    }

    const { newAutomation } = store.actions.deleteBlock(pathTo, automation)

    try {
      await store.actions.save(newAutomation)
    } catch (e) {
      notifications.error("Error deleting automation block")
      console.error("Automation deleting block ", e)
    }
  },

  replace: (automationId: string, automation?: Automation) => {
    if (!automation) {
      store.store.update(state => {
        state.automations = state.automations.filter(
          x => x._id !== automationId
        )
        if (automationId === state.selectedAutomationId) {
          store.actions.select(state.automations[0]?._id || null)
        }
        return state
      })
    } else {
      const index = get(store.store).automations.findIndex(
        x => x._id === automation._id
      )
      if (index === -1) {
        store.store.update(state => ({
          ...state,
          automations: [...state.automations, automation],
        }))
      } else {
        store.store.update(state => {
          state.automations[index] = automation
          return state
        })
      }
    }
  },

  create: async (name: string, trigger: AutomationTrigger) => {
    const automation: Automation = {
      name,
      type: "automation",
      appId: get(appStore).appId,
      definition: {
        steps: [],
        trigger,
      },
      disabled: false,
    }
    const response = await store.actions.save(automation)
    return response
  },

  duplicate: async (automation: Automation) => {
    const response = await store.actions.save({
      ...automation,
      name: `${automation.name} - copy`,
      _id: undefined,
      _rev: undefined,
    })
    return response
  },

  toggleDisabled: async (automationId: string) => {
    let automation: Automation | undefined
    try {
      automation = store.actions.getDefinition(automationId)
      if (!automation) {
        return
      }
      automation.disabled = !automation.disabled
      await store.actions.save(automation)
      notifications.success(
        `Automation ${
          automation.disabled ? "disabled" : "enabled"
        } successfully`
      )
    } catch (error) {
      notifications.error(
        `Error ${automation?.disabled ? "disabling" : "enabling"} automation`
      )
    }
  },

  definitions: async () => {
    const response = await API.getAutomationDefinitions()
    store.update(state => {
      state.blockDefinitions = getFinalDefinitions(
        response.trigger,
        response.action
      )
      return state
    })
    return response
  },

  fetch: async () => {
    const [automationResponse, definitions] = await Promise.all([
      API.getAutomations(),
      API.getAutomationDefinitions(),
    ])
    store.update(state => {
      state.automations = automationResponse.automations
      state.automations.sort((a, b) => {
        return a.name < b.name ? -1 : 1
      })
      state.blockDefinitions = getFinalDefinitions(
        definitions.trigger,
        definitions.action
      )
      return state
    })
  },

  select: (id: string | null) => {
    if (!id || id === get(store).selectedAutomationId) {
      return
    }
    store.update(state => {
      state.selectedAutomationId = id
      delete state.testResults
      state.showTestModal = false
      delete state.selectedNodeId
      state.showLogsPanel = false
      state.showLogDetailsPanel = false
      delete state.selectedLog
      delete state.selectedLogStepData
      return state
    })
  },

  getDefinition: (id: string): Automation | undefined => {
    return get(store.store).automations?.find(x => x._id === id)
  },

  getBlockDefinition: (block?: AutomationStep | AutomationTrigger) => {
    if (!block) {
      return
    }
    const isTrigger = block?.type === AutomationStepType.TRIGGER
    const definitionType = isTrigger
      ? BlockDefinitionTypes.TRIGGER
      : BlockDefinitionTypes.ACTION
    const definitions = get(store).blockDefinitions[definitionType]
    if (isTrigger) {
      const triggerDefs =
        definitions as Partial<GetAutomationTriggerDefinitionsResponse>
      return triggerDefs[block.stepId as AutomationTriggerStepId]
    }

    const stepDefs =
      definitions as Partial<GetAutomationActionDefinitionsResponse>
    return stepDefs[block.stepId as AutomationActionStepId]
  },

  /**
   * Determine if the trigger block type is a row trigger type
   * that supports oldRow/row
   * @param trigger
   * @returns {boolean}
   */
  isRowTrigger: (
    block?: AutomationTrigger | AutomationStep | undefined
  ): boolean => {
    if (!block || block.type !== AutomationStepType.TRIGGER) {
      return false
    }
    const stepId = block.stepId as AutomationTriggerStepId

    return RowTriggers.includes(stepId)
  },

  /**
   * Determine if the block is a row step type
   * The determines if something has a row/oldrow ux
   */
  isRowStep: (
    block?: AutomationTrigger | AutomationStep | undefined
  ): boolean => {
    if (!block || block.type !== AutomationStepType.ACTION) {
      return false
    }
    const stepId = block.stepId as AutomationActionStepId
    const rowSteps = [
      AutomationActionStepId.UPDATE_ROW,
      AutomationActionStepId.CREATE_ROW,
    ]
    return rowSteps.includes(stepId)
  },

  /**
   * Handler for row trigger automation updates.
   * @param {object} update - An automation block.inputs update object
   * @param {string} [update.tableId] - The ID of the table
   * @param {object} [update.filters] - Filter configuration for the row trigger
   * @param {object} [update.filters-def] - Filter definitions for the row trigger
   * @example
   * // Example with tableId
   * onRowTriggerUpdate({
   *   "tableId" : "ta_bb_employee"
   * })
   * @example
   * // Example with filters
   * onRowTriggerUpdate({
   *   filters: {
   *     equal: { "1:Approved": "true" }
   *   },
   *   "filters-def": [{
   *     id: "oH1T4S49n",
   *     field: "1:Approved",
   *     operator: "equal",
   *     value: "true",
   *     valueType: "Value",
   *     type: "string"
   *   }]
   * })
   */
  onRowTriggerUpdate: async (update: FormUpdate, block: AutomationTrigger) => {
    if (
      ["tableId", AutomationCustomIOType.FILTERS, "meta"].some(key =>
        Object.hasOwn(update, key)
      )
    ) {
      try {
        const automation = get(selectedAutomation)?.data

        if (!automation) {
          console.error("No automation for update")
          return
        }

        let updatedAutomation: Automation | undefined

        if (
          Object.hasOwn(update, "tableId") &&
          automation.testData?.row?.tableId !== update.tableId
        ) {
          const reqSchema = getSchemaForDatasourcePlus(update.tableId, {
            searchableSchema: true,
          }).schema

          updatedAutomation = await automationStore.actions.processBlockInputs(
            block,
            {
              schema: reqSchema,
              ...update,
            }
          )

          const refeshedTestData: AutomationTriggerResultOutputs = {
            row: { tableId: update.tableId },
            oldRow: { tableId: update.tableId },
            meta: {},
            id: "",
            revision: "",
          }

          // Reset testData when tableId changes
          updatedAutomation = updatedAutomation
            ? {
                ...updatedAutomation,
                testData: refeshedTestData,
              }
            : undefined
        } else {
          // For filters update, just process block inputs without resetting testData
          updatedAutomation = await automationStore.actions.processBlockInputs(
            block,
            update
          )
        }

        if (updatedAutomation) {
          await automationStore.actions.save(updatedAutomation)
        }
      } catch (e) {
        console.error("Error saving automation", e)
        notifications.error("Error saving automation")
      }
    }
  },

  onAppTriggerUpdate: async (update: FormUpdate, block: AutomationTrigger) => {
    try {
      // Parse the block inputs as usual
      const updatedAutomation =
        await automationStore.actions.processBlockInputs(block, {
          schema: {},
          ...update,
        })

      if (!updatedAutomation) {
        return
      }
      // Exclude default or invalid data from the test data
      let updatedFields: Record<string, any> = {}
      const inputs: Record<string, any> | void = block?.inputs
      const fieldsRequest = update.fields as Record<string, unknown>

      for (const key of Object.keys(inputs?.fields || {})) {
        if (Object.hasOwn(fieldsRequest, key)) {
          if (key !== "") {
            updatedFields[key] = updatedAutomation.testData?.fields?.[key]
          }
        }
      }

      // Save the entire automation and reset the testData
      await automationStore.actions.save({
        ...updatedAutomation,
        testData: {
          fields: updatedFields,
        },
      })
    } catch (e) {
      console.error("Error saving automation", e)
      notifications.error("Error saving automation")
    }
  },

  // Step Update Update
  requestUpdate: Utils.sequential(
    async (update: FormUpdate, block: AutomationTrigger | AutomationStep) => {
      if (!block || !update) {
        console.error("Invalid update. Block and update body required")
        return
      }

      const request = cloneDeep(update)

      const rowSteps = [
        AutomationTriggerStepId.ROW_DELETED,
        AutomationTriggerStepId.ROW_SAVED,
        AutomationTriggerStepId.ROW_UPDATED,
      ]

      // Process app trigger updates
      if (isTrigger(block)) {
        // Row trigger
        if (rowSteps.includes(block.stepId!)) {
          await store.actions.onRowTriggerUpdate(request, block)
          return
        }
        // App trigger
        if (block.stepId === AutomationTriggerStepId.APP) {
          await store.actions.onAppTriggerUpdate(request, block)
          return
        }
      }

      // We need to cache the schema as part of the definition because it is
      // used in the server to detect relationships. It would be far better to
      // instead fetch the schema in the backend at runtime.
      // If _tableId is explicitly included in the update request, the schema will be requested
      let schema: Record<any, any> = {}
      if (request?._tableId) {
        schema = getSchemaForDatasourcePlus(request._tableId, {
          searchableSchema: true,
        }).schema
        delete request._tableId
      }
      try {
        const data = { schema, ...request }
        const stepBlock = block as AutomationStep
        await automationStore.actions.updateBlockInputs(stepBlock, data)
      } catch (error) {
        console.error("Error saving automation", error)
        notifications.error("Error saving automation")
      }
    }
  ),

  save: async (automation: Automation) => {
    const response = await API.updateAutomation(automation)
    await store.actions.fetch()
    store.actions.select(response.automation._id!)
    return response.automation
  },

  delete: async (automation: Automation) => {
    const isRowAction = sdk.automations.isRowAction(automation)
    if (isRowAction) {
      const rowAction = automation.definition.trigger as RowActionTrigger
      const inputs = rowAction.inputs as AutomationTriggerInputs<
        typeof rowAction.stepId
      >

      await rowActions.delete(inputs.tableId, inputs.rowActionId)
    } else {
      await API.deleteAutomation(automation._id!, automation._rev!)
    }

    store.update(state => {
      state.automations = state.automations.filter(
        x => x._id !== automation._id
      )
      if (automation._id === state.selectedAutomationId) {
        state.selectedAutomationId = state.automations[0]?._id || null
      }
      return state
    })
  },

  /**
   * Update or clear the name of the target block from
   * the selected automation.
   *
   * @param block
   * @param newName
   */
  updateBlockTitle: async (block: AutomationStep, newName: string) => {
    if (newName.trim().length === 0) {
      await automationStore.actions.deleteAutomationName(block.id)
    } else {
      await automationStore.actions.saveAutomationName(block.id, newName)
    }
  },

  /**
   * Update the resource role for the automation resource
   * @param role
   * @returns
   */
  setPermissions: async (role?: string, automation?: Automation) => {
    if (!role || !automation?._id) {
      return
    }
    await permissions.save({
      level: PermissionLevel.EXECUTE,
      role,
      resource: automation?._id,
    })
  },

  getPermissions: async (automationId?: string) => {
    if (!automationId) {
      return
    }
    const perms = await permissions.forResource(automationId)
    if (!perms[PermissionLevel.EXECUTE]) {
      return "BASIC"
    } else {
      return perms[PermissionLevel.EXECUTE].role
    }
  },

  processBlockResults: (
    testResults?: TestAutomationResponse,
    block?: AutomationStep | AutomationTrigger
  ) => {
    if (!testResults || !block) {
      return
    }

    // DidNotTriggerResponse result for a row step filter
    if (
      isTrigger(block) &&
      isDidNotTriggerResponse(testResults) &&
      FilterableRowTriggers.includes(block.stepId)
    ) {
      return testResults
    }

    // Process the step/trigger automation results as normal.
    const stepTestResults = testResults as AutomationResults
    return (stepTestResults?.steps || []).find(step =>
      block.id ? step.id === block.id : step.stepId === block.stepId
    )
  },

  /**
   * Remove the target loop block from the automation and save.
   * @param blockRef The target loop block
   * @returns
   */
  removeLooping: async (blockRef?: BlockRef) => {
    if (!blockRef?.looped) {
      return
    }
    let loopBlockRef = get(selectedAutomation).blockRefs[blockRef.looped]
    if (loopBlockRef) {
      await automationStore.actions.deleteAutomationBlock(loopBlockRef.pathTo)
    }
  },

  /**
   * Creates a brand new loop block using the blockRef id as the
   * blockToLoop value. The new loop block is then added to the automation and saved
   * @param blockRef The block to be looped
   * @returns
   */
  addLooping: async (blockRef?: BlockRef) => {
    if (!blockRef) {
      return
    }
    const loopDefinition = get(store).blockDefinitions.ACTION.LOOP
    const loopBlock = automationStore.actions.constructBlock(
      BlockDefinitionTypes.ACTION,
      AutomationActionStepId.LOOP,
      loopDefinition
    )
    const blockDest = blockRef.pathTo.at(-1)
    loopBlock.blockToLoop = blockDest!.id

    await automationStore.actions.addBlockToAutomation(
      loopBlock,
      blockRef.pathTo
    )
  },

  /**
   * Focus the automation canvas on one particular step in the
   * automation. Open the sidebar and set the data mode.
   * @param blockId
   * @param mode Defaults to DataMode.Input
   */
  selectNode: async (blockId?: string, mode?: DataMode) => {
    store.update(state => {
      return {
        ...state,
        selectedNodeId: blockId,
        selectedNodeMode: mode ?? DataMode.INPUT,
      }
    })
  },

  openActionPanel: (block: BlockRef) => {
    store.update(state => ({
      ...state,
      actionPanelBlock: block,
      selectedNodeId: undefined,
    }))
  },
  closeActionPanel: () => {
    store.update(state => ({
      ...state,
      actionPanelBlock: undefined,
    }))
  },

  openLogPanel: (log: any, stepData: any) => {
    store.update(state => ({
      ...state,
      showLogDetailsPanel: true,
      selectedLog: log,
      selectedLogStepData: stepData,
      selectedNodeId: undefined,
      actionPanelBlock: undefined,
    }))
  },

  closeLogPanel: () => {
    store.update(state => ({
      ...state,
      showLogDetailsPanel: false,
      selectedLog: undefined,
      selectedLogStepData: undefined,
    }))
  },

  openLogsPanel: () => {
    store.update(state => ({
      ...state,
      showLogsPanel: true,
      selectedNodeId: undefined,
      actionPanelBlock: undefined,
      showLogDetailsPanel: false,
    }))
  },

  closeLogsPanel: () => {
    store.update(state => ({
      ...state,
      showLogsPanel: false,
    }))
  },

  selectLogForDetails: (log: any) => {
    store.update(state => ({
      ...state,
      selectedLog: log,
      showLogDetailsPanel: false,
    }))
  },
})

export interface AutomationContext {
  user: AppSelfResponse | null
  trigger?: AutomationTriggerResultOutputs
  steps: Record<string, AutomationStep>
  env?: Record<string, any>
  settings: Record<string, any>
}

export class SelectedAutomationStore extends DerivedBudiStore<
  AutomationState,
  DerivedAutomationState
> {
  constructor(automationStore: AutomationStore) {
    const makeDerivedStore = () => {
      return derived(automationStore, $store => {
        if (!$store.selectedAutomationId) {
          return {
            blockRefs: {},
            ...$store,
          }
        }

        const selected = $store.automations?.find(
          x => x._id === $store.selectedAutomationId
        )

        if (!selected) {
          return {
            blockRefs: {},
            ...$store,
          }
        }

        const blockRefs: Record<string, BlockRef> = {}
        const updatedAuto = cloneDeep(selected)

        // Only traverse if we have a valid automation
        if (updatedAuto) {
          automationStore.actions.traverse(blockRefs, updatedAuto)

          Object.values(blockRefs)
            .filter(blockRef => blockRef.terminating)
            .forEach(blockRef => {
              automationStore.actions
                .getPathSteps(blockRef.pathTo, updatedAuto)
                .forEach((step, idx, steps) => {
                  migrateReferencesInObject({
                    obj: step,
                    originalIndex: idx,
                    steps,
                  })
                })
            })
        }

        return {
          data: updatedAuto,
          blockRefs,
          ...$store,
        }
      })
    }

    super(initialAutomationState, makeDerivedStore)
  }
}

class AutomationStore extends BudiStore<AutomationState> {
  history: HistoryStore<Automation>
  actions: ReturnType<typeof automationActions>
  selected: SelectedAutomationStore

  constructor() {
    super(initialAutomationState)
    this.actions = automationActions(this)
    this.history = createHistoryStore({
      getDoc: this.actions.getDefinition.bind(this),
      selectDoc: this.actions.select.bind(this),
    })

    // Then wrap save and delete with history
    const originalSave = this.actions.save.bind(this.actions)
    const originalDelete = this.actions.delete.bind(this.actions)
    this.actions.save = this.history.wrapSaveDoc(originalSave)
    this.actions.delete = this.history.wrapDeleteDoc(originalDelete)

    this.selected = new SelectedAutomationStore(this)
  }
}

export const automationStore = new AutomationStore()

export const automationHistoryStore = automationStore.history
export const selectedAutomation = automationStore.selected

/**
 * Pad out a base default context for subscribers
 */
const emptyContext: AutomationContext = {
  user: {},
  steps: {},
  settings: {
    url: "",
    company: "",
    logo: "",
  },
}

const generateContext = () => {
  if (!organisation || !automationStore?.selected || !environment || !tables) {
    return readable(emptyContext)
  }
  return derived(
    [organisation, automationStore.selected, environment, tables],
    ([
      $organisation,
      $selectedAutomation,
      $env,
      $tables,
    ]): AutomationContext => {
      const { platformUrl: url, company, logoUrl: logo } = $organisation

      const results: TestAutomationResponse | undefined =
        $selectedAutomation?.testResults

      const testData: AutomationTriggerResultOutputs | undefined =
        $selectedAutomation.data?.testData

      const triggerDef = $selectedAutomation.data?.definition?.trigger

      const isWebhook = triggerDef?.stepId === AutomationTriggerStepId.WEBHOOK
      const isRowAction =
        triggerDef?.stepId === AutomationTriggerStepId.ROW_ACTION

      const triggerInputs = triggerDef
        ? (triggerDef.inputs as AutomationTriggerInputs<
            typeof triggerDef.stepId
          >)
        : undefined

      let triggerData: AutomationTriggerResultOutputs | undefined

      if (results && isAutomationResults(results)) {
        const automationTrigger: AutomationTriggerResult | undefined =
          results?.trigger

        const outputs: AutomationTriggerResultOutputs | undefined =
          automationTrigger?.outputs
        triggerData = outputs ? outputs : undefined

        if (triggerData) {
          if (isRowAction) {
            const rowActionInputs: RowActionTriggerInputs =
              triggerInputs as RowActionTriggerInputs
            const rowActionTableId = rowActionInputs.tableId
            const rowActionTable = $tables.list.find(
              table => table._id === rowActionTableId
            )

            const rowTriggerOutputs = triggerData as RowActionTriggerOutputs

            if (rowActionTable) {
              // Row action table must always be retrieved as it is never
              // returned in the test results
              rowTriggerOutputs.table = rowActionTable
            }
          } else if (isWebhook) {
            const webhookTrigger = triggerData as WebhookTriggerOutputs
            // Ensure it displays in the event that the configuration was been skipped
            webhookTrigger.body = webhookTrigger.body ?? {}
          }
        }

        // Clean up unnecessary data from the context
        // Meta contains UI/UX config data. Non-bindable
        delete triggerData?.meta
      } else {
        // Substitute test data in place of the trigger data if the test hasn't been run
        triggerData = testData
      }

      // AppSelf context required to mirror server user context
      const userContext = $selectedAutomation.appSelf || {}

      // Extract step results from a valid response
      const stepResults =
        results && isAutomationResults(results) ? results?.steps : []

      // Env vars require a license. In the event they are empty or unavailable
      // the UI wont display an empty section in the context
      const envVars = $env?.variables.length
        ? $env?.variables.reduce(
            (acc: Record<string, any>, variable: Record<string, any>) => {
              acc[variable.name] = ""
              return acc
            },
            {}
          )
        : undefined

      // Result data from a completed test run
      // Initially contain info around
      const stepContext = stepResults.reduce(
        (acc: Record<string, any>, res: Record<string, any>) => {
          acc[res.id] = res.outputs
          return acc
        },
        {}
      )

      return {
        user: userContext,
        // Merge in the trigger data.
        ...(triggerData ? { trigger: { ...triggerData } } : {}),
        steps: stepContext,
        ...(envVars ? { env: envVars } : {}),
        settings: { url, company, logo },
      }
    },
    emptyContext
  )
}

/**
 * Generates a derived store acting as an evaluation context
 * for bindings in automations
 *
 * @returns {Readable<AutomationContext>}
 */
export const evaluationContext: Readable<AutomationContext> = generateContext()
