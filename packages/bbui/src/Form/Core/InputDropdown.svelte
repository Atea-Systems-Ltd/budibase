<script>
  import "@spectrum-css/inputgroup/dist/index-vars.css"
  import "@spectrum-css/popover/dist/index-vars.css"
  import "@spectrum-css/menu/dist/index-vars.css"
  import { fly } from "svelte/transition"
  import { createEventDispatcher } from "svelte"
  import clickOutside from "../../Actions/click_outside"
  import Icon from "../../Icon/Icon.svelte"

  export let inputValue
  export let dropdownValue
  export let id = null
  export let inputType = "text"
  export let placeholder = "Choose an option or type"
  export let disabled = false
  export let readonly = false
  export let updateOnChange = true
  export let options = []
  export let getOptionLabel = option => extractProperty(option, "label")
  export let getOptionValue = option => extractProperty(option, "value")
  export let getOptionSubtitle = option => option?.subtitle
  export let isOptionSelected = () => false

  const dispatch = createEventDispatcher()
  let open = false
  let focus = false

  $: fieldText = getFieldText(dropdownValue, options, placeholder)

  const getFieldText = (dropdownValue, options, placeholder) => {
    // Always use placeholder if no value
    if (dropdownValue == null || dropdownValue === "") {
      return placeholder || "Choose an option or type"
    }

    // Wait for options to load if there is a value but no options
    if (!options?.length) {
      return ""
    }

    // Render the label if the selected option is found, otherwise raw value
    const selected = options.find(
      option => getOptionValue(option) === dropdownValue
    )
    return selected ? getOptionLabel(selected) : dropdownValue
  }

  const updateValue = newValue => {
    if (readonly) {
      return
    }
    dispatch("change", newValue)
  }

  const onFocus = () => {
    if (readonly) {
      return
    }
    focus = true
  }

  const onBlur = event => {
    if (readonly) {
      return
    }
    focus = false
    updateValue(event.target.value)
  }

  const onInput = event => {
    if (readonly || !updateOnChange) {
      return
    }
    updateValue(event.target.value)
  }

  const updateValueOnEnter = event => {
    if (readonly) {
      return
    }
    if (event.key === "Enter") {
      updateValue(event.target.value)
    }
  }

  const onClick = () => {
    dispatch("click")
    if (readonly) {
      return
    }
    open = true
  }

  const onPick = newValue => {
    dispatch("pick", newValue)
    open = false
  }

  const extractProperty = (value, property) => {
    if (value && typeof value === "object") {
      return value[property]
    }
    return value
  }

  const handleOutsideClick = event => {
    if (open) {
      event.stopPropagation()
      open = false
    }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="spectrum-InputGroup" class:is-disabled={disabled}>
  <div
    class="spectrum-Textfield spectrum-InputGroup-textfield"
    class:is-disabled={disabled}
    class:is-focused={focus}
  >
    <input
      {id}
      on:click
      on:blur
      on:focus
      on:input
      on:keyup
      on:blur={onBlur}
      on:focus={onFocus}
      on:input={onInput}
      on:keyup={updateValueOnEnter}
      value={inputValue || ""}
      placeholder={placeholder || ""}
      {disabled}
      {readonly}
      {inputType}
      class="spectrum-Textfield-input spectrum-InputGroup-input"
    />
  </div>
  <div style="width: 40%">
    <button
      {id}
      class="spectrum-Picker spectrum-Picker--sizeM override-borders"
      {disabled}
      class:is-open={open}
      aria-haspopup="listbox"
      on:click={onClick}
    >
      <span class="spectrum-Picker-label">
        <div>
          {fieldText}
        </div></span
      >
      <Icon name="caret-down" size="S" />
    </button>
  </div>
  {#if open}
    <div
      use:clickOutside={handleOutsideClick}
      transition:fly|local={{ y: -20, duration: 200 }}
      class="spectrum-Popover spectrum-Popover--bottom spectrum-Picker-popover is-open"
    >
      <ul class="spectrum-Menu" role="listbox">
        {#each options as option, idx}
          <li
            class="spectrum-Menu-item"
            class:is-selected={isOptionSelected(getOptionValue(option, idx))}
            role="option"
            aria-selected="true"
            tabindex="0"
            on:click={() => onPick(getOptionValue(option, idx))}
          >
            <span class="spectrum-Menu-itemLabel">
              {getOptionLabel(option, idx)}
              {#if getOptionSubtitle(option, idx)}
                <span class="subtitle-text">
                  {getOptionSubtitle(option, idx)}
                </span>
              {/if}
            </span>
            <div class="check">
              <Icon
                name="check"
                size="S"
                weight="bold"
                color="var(--spectrum-global-color-blue-500)"
              />
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .spectrum-InputGroup {
    min-width: 0;
    width: 100%;
  }
  .spectrum-InputGroup-input {
    border-right-width: 1px;
  }
  .spectrum-Textfield {
    width: 100%;
  }
  .spectrum-Textfield-input {
    width: 0;
  }
  .override-borders {
    border-top-left-radius: 0px;
    border-bottom-left-radius: 0px;
  }
  .spectrum-Popover {
    max-height: 240px;
    z-index: 999;
    top: 100%;
    width: 100%;
  }
  .subtitle-text {
    font-size: 12px;
    line-height: 15px;
    font-weight: 500;
    color: var(--spectrum-global-color-gray-600);
    display: block;
    margin-top: var(--spacing-s);
  }
  .check {
    display: none;
  }
  li.is-selected .check {
    display: block;
  }
</style>
