<script>
  import { CoreTextField } from "@budibase/bbui"
  import Field from "./Field.svelte"

  export let field
  export let label
  export let placeholder
  export let type = "text"
  export let disabled = false
  export let readonly = false
  export let validation
  export let defaultValue = ""
  export let align
  export let onChange
  export let runOnInput = false
  export let span
  export let helpText = null

  let fieldState
  let fieldApi

  const handleChange = e => {
    const changed = fieldApi.setValue(e.detail)
    if (changed) {
      onChange?.({ value: e.detail })
    }
  }

  const handleInput = e => {
    onChange?.({ value: e.target.value })
  }
</script>

<Field
  {label}
  {field}
  {disabled}
  {readonly}
  {validation}
  {defaultValue}
  {span}
  {helpText}
  type={type === "number" ? "number" : "string"}
  bind:fieldState
  bind:fieldApi
>
  {#if fieldState}
    <CoreTextField
      updateOnChange={false}
      value={fieldState.value}
      on:change={handleChange}
      on:input={runOnInput ? handleInput : undefined}
      disabled={fieldState.disabled}
      readonly={fieldState.readonly}
      id={fieldState.fieldId}
      {placeholder}
      {type}
      {align}
    />
  {/if}
</Field>
