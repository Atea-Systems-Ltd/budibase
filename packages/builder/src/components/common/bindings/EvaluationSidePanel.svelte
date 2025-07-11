<script lang="ts">
  import { JsonFormatter } from "@budibase/frontend-core"
  import { Icon, ProgressCircle, notifications } from "@budibase/bbui"
  import { Helpers } from "@budibase/bbui"
  import { fade } from "svelte/transition"
  import { UserScriptError } from "@budibase/string-templates"
  import type { Log } from "@budibase/string-templates"
  import type { JSONValue } from "@budibase/types"

  // this can be essentially any primitive response from the JS function
  export let expressionResult: JSONValue | undefined = undefined
  export let expressionError: string | undefined = undefined
  export let expressionLogs: Log[] = []
  export let evaluating = false
  export let expression: string | null = null

  $: error = expressionError != null
  $: empty = expression == null || expression?.trim() === ""
  $: success = !error && !empty
  $: highlightedResult = highlight(expressionResult)
  $: highlightedLogs = expressionLogs.map(l => ({
    log: l.log.map(part => highlight(part)).join(", "),
    line: l.line,
    type: l.type,
  }))

  const formatError = (err: any) => {
    if (err.code === UserScriptError.code) {
      return err.userScriptError.toString()
    }
    return err.toString()
  }

  // json can be any primitive type
  const highlight = (json?: JSONValue | null) => {
    if (json == null) {
      return ""
    }

    // Attempt to parse and then stringify, in case this is valid result
    try {
      json = JSON.stringify(JSON.parse(json as any), null, 2)
    } catch (err) {
      // couldn't parse/stringify, just treat it as the raw input
    }

    return JsonFormatter.format(json, {
      keyColor: "#e06c75",
      numberColor: "#e5c07b",
      stringColor: "#98c379",
      trueColor: "#d19a66",
      falseColor: "#d19a66",
      nullColor: "#c678dd",
    })
  }

  const copy = () => {
    let clipboardVal = expressionResult
    if (typeof clipboardVal === "object") {
      clipboardVal = JSON.stringify(clipboardVal, null, 2)
    }
    Helpers.copyToClipboard(clipboardVal)
    notifications.success("Value copied to clipboard")
  }
</script>

<div class="evaluation-side-panel">
  <div class="header" class:success class:error>
    <div class="header-content">
      {#if error}
        <Icon name="warning" color="var(--error-content)" />
        <div>Error</div>
        {#if evaluating}
          <div transition:fade|local={{ duration: 130 }}>
            <ProgressCircle size="S" />
          </div>
        {/if}
        <span />
        <Icon name="copy" size="S" hoverable on:click={copy} />
      {:else}
        <div>Preview</div>
        {#if evaluating}
          <div transition:fade|local={{ duration: 130 }}>
            <ProgressCircle size="S" />
          </div>
        {/if}
        <span />
        {#if !empty}
          <Icon name="copy" size="S" hoverable on:click={copy} />
        {/if}
      {/if}
    </div>
  </div>
  <div class="body">
    {#if empty}
      Your expression will be evaluated here
    {:else if error}
      <div class="error-msg">
        {formatError(expressionError)}
      </div>
    {:else}
      <div class="output-lines">
        {#each highlightedLogs as logLine}
          <div
            class="line"
            class:error-log={logLine.type === "error"}
            class:warn-log={logLine.type === "warn"}
          >
            <div class="icon-log">
              {#if logLine.type === "error"}
                <Icon size="XS" name="xcircle" color="var(--error-content)" />
              {:else if logLine.type === "warn"}
                <Icon size="XS" name="warning" color="var(--warning-content)" />
              {/if}
              <!-- eslint-disable-next-line svelte/no-at-html-tags-->
              <span>{@html logLine.log}</span>
            </div>
            {#if logLine.line}
              <span style="color: var(--blue); overflow-wrap: normal;"
                >:{logLine.line}</span
              >
            {/if}
          </div>
        {/each}
        <div class="line">
          <div>
            <!-- eslint-disable-next-line svelte/no-at-html-tags-->
            {@html highlightedResult}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .evaluation-side-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: stretch;
    border-left: var(--border-light);
  }
  .header {
    padding: var(--spacing-m) var(--spacing-l);
    flex: 0 0 auto;
    position: relative;
    border-bottom: var(--border-light);
  }
  .header-content {
    height: var(--spectrum-alias-item-height-m);
    display: flex;
    align-items: center;
    z-index: 2;
    position: relative;
    gap: var(--spacing-m);
  }
  .header-content span {
    flex: 1 1 auto;
  }
  .header.error::before {
    content: "";
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
    position: absolute;
  }
  .header.error::before {
    background: var(--error-bg);
  }
  .error-msg {
    padding-top: var(--spacing-m);
  }
  .body {
    flex: 1 1 auto;
    font-family: var(--font-mono);
    margin: 0 var(--spacing-m);
    font-size: 12px;
    overflow-y: auto;
    overflow-x: hidden;
    word-wrap: anywhere;
    height: 0;
  }
  .output-lines {
    display: flex;
    flex-direction: column;
  }
  .line {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: end;
    padding: var(--spacing-m) 0;
    word-wrap: anywhere;
  }
  .line:not(:first-of-type) {
    border-top: var(--border-light);
  }
  .icon-log {
    display: flex;
    gap: var(--spacing-s);
    align-items: start;
  }
</style>
