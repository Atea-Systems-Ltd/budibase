<script lang="ts">
  import {
    Button,
    Drawer,
    Input,
    Icon,
    AbsTooltip,
    TooltipType,
    notifications,
  } from "@budibase/bbui"
  import BindingPanel from "@/components/common/bindings/BindingPanel.svelte"
  import { decodeJSBinding, encodeJSBinding } from "@budibase/string-templates"
  import { snippets } from "@/stores/builder"
  import { getSequentialName } from "@/helpers/duplicate"
  import ConfirmDialog from "@/components/common/ConfirmDialog.svelte"
  import { ValidSnippetNameRegex } from "@budibase/shared-core"
  import type { Snippet } from "@budibase/types"

  export const show = () => {
    if (!snippet) {
      key = Math.random().toString()
      // Reset state when creating multiple snippets
      code = ""
      name = defaultName
    }
    drawer.show()
  }
  export const hide = () => drawer.hide()
  export let snippet: Snippet | null

  const firstCharNumberRegex = /^[0-9].*$/

  let drawer: Drawer
  let name = ""
  let code = ""
  let loading = false
  let deleteConfirmationDialog: ConfirmDialog

  $: defaultName = getSequentialName($snippets, "MySnippet", {
    getName: x => x.name,
  })
  $: key = snippet?.name
  $: name = snippet?.name || defaultName
  $: code = snippet?.code ? encodeJSBinding(snippet.code) : ""
  $: rawJS = decodeJSBinding(code)
  $: nameError = validateName(name, $snippets)

  const saveSnippet = async () => {
    loading = true
    try {
      const newSnippet: Snippet = { name, code: rawJS || "" }
      await snippets.saveSnippet(newSnippet)
      drawer.hide()
      notifications.success(`Snippet ${newSnippet.name} saved`)
    } catch (error: any) {
      notifications.error(error.message || "Error saving snippet")
    }
    loading = false
  }

  const deleteSnippet = async () => {
    loading = true
    try {
      if (snippet) {
        await snippets.deleteSnippet(snippet.name)
      }
      drawer.hide()
    } catch (error) {
      notifications.error("Error deleting snippet")
    }
    loading = false
  }

  const validateName = (name: string, snippets: Snippet[]) => {
    if (!name?.length) {
      return "Name is required"
    }
    if (!snippet?.name && snippets.some(snippet => snippet.name === name)) {
      return "That name is already in use"
    }
    if (firstCharNumberRegex.test(name)) {
      return "Can't start with a number"
    }
    if (!ValidSnippetNameRegex.test(name)) {
      return "No special characters or spaces"
    }
    return null
  }
</script>

<Drawer bind:this={drawer}>
  <svelte:fragment slot="title">
    {#if snippet}
      {snippet.name}
    {:else}
      <div class="name" class:invalid={nameError != null}>
        <span>Name</span>
        <Input bind:value={name} />
        {#if nameError}
          <AbsTooltip text={nameError} type={TooltipType.Negative}>
            <Icon
              name="question"
              size="S"
              color="var(--spectrum-global-color-red-400)"
            />
          </AbsTooltip>
        {/if}
      </div>
    {/if}
  </svelte:fragment>
  <svelte:fragment slot="buttons">
    {#if snippet}
      <Button
        warning
        on:click={deleteConfirmationDialog.show}
        disabled={loading}
      >
        Delete
      </Button>
    {/if}
    <Button
      cta
      on:click={saveSnippet}
      disabled={!code || loading || !!nameError}
    >
      Save
    </Button>
  </svelte:fragment>
  <svelte:fragment slot="body">
    {#key key}
      <BindingPanel
        allowHBS={false}
        allowJS
        allowSnippets={false}
        allowHelpers={false}
        showTabBar={false}
        placeholder="return function(input) &#10100; ... &#10101;"
        value={code}
        on:change={e => (code = e.detail)}
      >
        <Input placeholder="Name" />
      </BindingPanel>
    {/key}
  </svelte:fragment>
</Drawer>

<ConfirmDialog
  bind:this={deleteConfirmationDialog}
  title="Delete snippet"
  body={`Are you sure you want to delete ${snippet?.name}?`}
  onOk={deleteSnippet}
/>

<style>
  .name {
    display: flex;
    gap: var(--spacing-l);
    align-items: center;
    position: relative;
  }
  .name :global(input) {
    width: 200px;
  }
  .name.invalid :global(input) {
    padding-right: 32px;
  }
  .name :global(.icon) {
    position: absolute;
    right: 10px;
  }
</style>
