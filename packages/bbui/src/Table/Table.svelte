<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte"
  import "@spectrum-css/table/dist/index-vars.css"
  import CellRenderer from "./CellRenderer.svelte"
  import SelectEditRenderer from "./SelectEditRenderer.svelte"
  import { cloneDeep, deepGet } from "../helpers"
  import ProgressCircle from "../ProgressCircle/ProgressCircle.svelte"
  import Checkbox from "../Form/Checkbox.svelte"
  import Icon from "../Icon/Icon.svelte"

  /**
   /**
   * The expected schema is our normal couch schemas for our tables.
   * Each field schema can be enriched with a few extra properties to customise
   * the behaviour.
   * All of these are optional and do not need to be added.
   * displayName: Overrides the field name displayed as the column title
   * sortable: Set to false to disable sorting data by a certain column
   * editable: Set to false to disable editing a certain column if the
   *  allowEditColumns prop is true
   * width: the width of the column
   * align: the alignment of the column
   * template: a HBS or JS binding to use as the value
   * background: the background color
   * color: the text color
   * borderLeft: show a left border
   * borderRight: show a right border
   */
  export let data: any[] = []
  export let schema: Record<string, any> = {}
  export let showAutoColumns: boolean = false
  export let rowCount: number = 0
  export let quiet: boolean = false
  export let loading: boolean = false
  export let allowSelectRows: boolean = false
  export let allowEditRows: boolean = true
  export let allowEditColumns: boolean = true
  export let allowClickRows: boolean = true
  export let selectedRows: any[] = []
  export let customRenderers: any[] = []
  export let disableSorting: boolean = false
  export let autoSortColumns: boolean = true
  export let compact: boolean = false
  export let customPlaceholder: boolean = false
  export let showHeaderBorder: boolean = true
  export let placeholderText: string = "No rows found"
  export let snippets: any[] = []
  export let defaultSortColumn: string | undefined = undefined
  export let defaultSortOrder: "Ascending" | "Descending" = "Ascending"

  const dispatch = createEventDispatcher()

  let ref: HTMLDivElement

  // Config
  const headerHeight: number = 36
  $: rowHeight = compact ? 46 : 55

  // Sorting state
  let sortColumn: string | undefined
  let sortOrder: "Ascending" | "Descending" | undefined

  // Table state
  let height: number = 0
  let loaded: boolean = false
  let checkboxStatus: boolean = false

  $: schema = fixSchema(schema)
  $: if (!loading) loaded = true
  $: fields = getFields(schema, showAutoColumns, autoSortColumns)
  $: rows = fields?.length ? data || [] : []
  $: totalRowCount = rows?.length || 0
  $: visibleRowCount = getVisibleRowCount(
    loaded,
    height,
    rows.length,
    rowCount,
    rowHeight
  )
  $: heightStyle = getHeightStyle(
    visibleRowCount,
    rowCount,
    totalRowCount,
    rowHeight,
    loading
  )
  $: sortedRows = sortRows(rows, sortColumn, sortOrder)
  $: gridStyle = getGridStyle(fields, schema, showEditColumn)
  $: showEditColumn = allowEditRows || allowSelectRows
  $: cellStyles = computeCellStyles(schema)

  // Deselect the "select all" checkbox when the user navigates to a new page
  $: {
    let checkRowCount = rows.filter(o1 =>
      selectedRows.some(o2 => o1._id === o2._id)
    )
    if (checkRowCount.length === 0) {
      checkboxStatus = false
    }
  }

  const fixSchema = (schema: Record<string, any>): Record<string, any> => {
    let fixedSchema: Record<string, any> = {}
    Object.entries(schema || {}).forEach(([fieldName, fieldSchema]) => {
      if (typeof fieldSchema === "string") {
        fixedSchema[fieldName] = {
          type: fieldSchema,
          name: fieldName,
        }
      } else {
        fixedSchema[fieldName] = {
          ...fieldSchema,
          name: fieldName,
        }
      }

      // Delete numeric only widths as these are grid widths and should be
      // ignored
      const width = fixedSchema[fieldName].width
      if (width != null && `${width}`.trim().match(/^[0-9]+$/)) {
        delete fixedSchema[fieldName].width
      }
    })
    return fixedSchema
  }

  const getVisibleRowCount = (
    loaded: boolean,
    height: number,
    allRows: number,
    rowCount: number,
    rowHeight: number
  ): number => {
    if (!loaded) {
      return rowCount || 0
    }
    if (rowCount) {
      return Math.min(allRows, rowCount)
    }
    return Math.min(allRows, Math.ceil(height / rowHeight))
  }

  const getHeightStyle = (
    visibleRowCount: number,
    rowCount: number,
    totalRowCount: number,
    rowHeight: number,
    loading: boolean
  ): string => {
    if (loading) {
      return `height: ${headerHeight + visibleRowCount * rowHeight}px;`
    }
    if (!rowCount || !visibleRowCount || totalRowCount <= rowCount) {
      return ""
    }
    return `height: ${headerHeight + visibleRowCount * rowHeight}px;`
  }

  const getGridStyle = (
    fields: string[],
    schema: Record<string, any>,
    showEditColumn: boolean
  ): string => {
    let style = "grid-template-columns:"
    if (showEditColumn) {
      style += " auto"
    }
    fields?.forEach(field => {
      const fieldSchema = schema[field]
      if (fieldSchema.width && typeof fieldSchema.width === "string") {
        style += ` ${fieldSchema.width}`
      } else {
        style += " minmax(auto, 1fr)"
      }
    })
    style += ";"
    return style
  }

  const sortRows = (
    rows: any[],
    sortColumn: string | undefined,
    sortOrder: string | undefined
  ): any[] => {
    sortColumn = sortColumn ?? defaultSortColumn
    sortOrder = sortOrder ?? defaultSortOrder
    if (!sortColumn || !sortOrder || disableSorting) {
      return rows
    }
    return rows.slice().sort((a, b) => {
      const colA = a[sortColumn]
      const colB = b[sortColumn]
      if (sortOrder === "Descending") {
        return colA > colB ? -1 : 1
      } else {
        return colA > colB ? 1 : -1
      }
    })
  }

  const sortBy = (fieldSchema: Record<string, any>): void => {
    if (fieldSchema.sortable === false) {
      return
    }
    if (fieldSchema.name === sortColumn) {
      sortOrder = sortOrder === "Descending" ? "Ascending" : "Descending"
    } else {
      sortColumn = fieldSchema.name
      sortOrder = "Descending"
    }
    dispatch("sort", { column: sortColumn, order: sortOrder })
  }

  const getDisplayName = (schema: Record<string, any>): string => {
    let name = schema?.displayName
    if (schema && name === undefined) {
      name = schema.name
    }
    return name || ""
  }

  const getFields = (
    schema: Record<string, any>,
    showAutoColumns: boolean,
    autoSortColumns: boolean
  ): string[] => {
    let columns: any[] = []
    let autoColumns: any[] = []
    Object.entries(schema || {}).forEach(([field, fieldSchema]) => {
      if (!field || !fieldSchema) {
        return
      }
      if (!autoSortColumns || !fieldSchema?.autocolumn) {
        columns.push(fieldSchema)
      } else if (showAutoColumns) {
        autoColumns.push(fieldSchema)
      }
    })
    return columns
      .sort((a, b) => {
        if (a.divider) {
          return a
        }
        if (b.divider) {
          return b
        }
        const orderA = a.order || Number.MAX_SAFE_INTEGER
        const orderB = b.order || Number.MAX_SAFE_INTEGER
        const nameA = getDisplayName(a)
        const nameB = getDisplayName(b)
        if (orderA !== orderB) {
          return orderA < orderB ? a : b
        }
        return nameA < nameB ? a : b
      })
      .concat(autoColumns)
      .map(column => column.name)
  }

  const editColumn = (e: Event, field: any): void => {
    e.stopPropagation()
    dispatch("editcolumn", field)
  }

  const editRow = (e: Event, row: any): void => {
    e.stopPropagation()
    dispatch("editrow", cloneDeep(row))
  }

  const toggleSelectRow = (row: any): void => {
    if (!allowSelectRows) {
      return
    }
    if (selectedRows.some(selectedRow => selectedRow._id === row._id)) {
      selectedRows = selectedRows.filter(
        selectedRow => selectedRow._id !== row._id
      )
    } else {
      selectedRows = [...selectedRows, row]
    }
  }

  const toggleSelectAll = (e: CustomEvent): void => {
    const select = !!e.detail
    if (select) {
      // Add any rows which are not already in selected rows
      rows.forEach(row => {
        if (
          row.__selectable !== false &&
          selectedRows.findIndex(x => x._id === row._id) === -1
        ) {
          selectedRows.push(row)
        }
      })
    } else {
      // Remove any rows from selected rows that are in the current data set
      selectedRows = selectedRows.filter(el =>
        rows.every(f => f._id !== el._id)
      )
    }
  }

  const computeCellStyles = (
    schema: Record<string, any>
  ): Record<string, string> => {
    let styles: Record<string, string> = {}
    Object.keys(schema || {}).forEach(field => {
      styles[field] = ""
      if (schema[field].color) {
        styles[field] += `color: ${schema[field].color};`
      }
      if (schema[field].background) {
        styles[field] += `background-color: ${schema[field].background};`
      }
      if (schema[field].align === "Center") {
        styles[field] += "justify-content: center; text-align: center;"
      }
      if (schema[field].align === "Right") {
        styles[field] += "justify-content: flex-end; text-align: right;"
      }
      if (schema[field].borderLeft) {
        styles[field] +=
          "border-left: 1px solid var(--spectrum-global-color-gray-200);"
      }
      if (schema[field].borderLeft) {
        styles[field] +=
          "border-right: 1px solid var(--spectrum-global-color-gray-200);"
      }
      if (schema[field].minWidth) {
        styles[field] += `min-width: ${schema[field].minWidth};`
      }
    })
    return styles
  }

  // Instead of svelte bind:offsetWidth
  // Svelte injects an iframe causing issues with CSP, this avoids it
  const setupResizeObserver = (element: HTMLElement) => {
    const resizeObserver = new ResizeObserver(entries => {
      if (!entries?.[0]) {
        return
      }
      const bounds = entries[0].target.getBoundingClientRect()
      height = bounds.height //the offsetHeight
    })
    resizeObserver.observe(element)
    return resizeObserver
  }

  onMount(() => {
    let resizeObserver = setupResizeObserver(ref)
    return () => {
      resizeObserver.disconnect()
    }
  })
</script>

{#key fields?.length}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div
    bind:this={ref}
    class="wrapper"
    class:wrapper--quiet={quiet}
    class:wrapper--compact={compact}
    style={`--row-height: ${rowHeight}px; --header-height: ${headerHeight}px;`}
  >
    {#if loading}
      <div class="loading" style={heightStyle}>
        <slot name="loadingIndicator">
          <ProgressCircle />
        </slot>
      </div>
    {:else}
      <div
        class="spectrum-Table"
        class:no-scroll={!rowCount}
        style={`${heightStyle}${gridStyle}`}
      >
        {#if fields.length}
          <div class="spectrum-Table-head">
            {#if showEditColumn}
              <div
                class:noBorderHeader={!showHeaderBorder}
                class="spectrum-Table-headCell spectrum-Table-headCell--divider spectrum-Table-headCell--edit"
              >
                {#if allowSelectRows}
                  <Checkbox
                    bind:value={checkboxStatus}
                    on:change={toggleSelectAll}
                  />
                {:else}
                  Edit
                {/if}
              </div>
            {/if}
            {#each fields as field}
              <div
                class="spectrum-Table-headCell"
                class:noBorderHeader={!showHeaderBorder}
                class:spectrum-Table-headCell--alignCenter={schema[field]
                  .align === "Center"}
                class:spectrum-Table-headCell--alignRight={schema[field]
                  .align === "Right"}
                class:is-sortable={schema[field].sortable !== false}
                class:is-sorted-desc={sortColumn === field &&
                  sortOrder === "Descending"}
                class:is-sorted-asc={sortColumn === field &&
                  sortOrder === "Ascending"}
                on:click={() => sortBy(schema[field])}
              >
                <div class="title" title={field}>
                  {getDisplayName(schema[field])}
                  {#if schema[field]?.autocolumn}
                    <Icon
                      name="magic-wand"
                      size="S"
                      color="var(--spectrum-global-color-gray-600)"
                    />
                  {/if}
                  {#if sortColumn === field}
                    <Icon
                      name="caret-down"
                      size="S"
                      color="var(--spectrum-global-color-gray-700)"
                    />
                  {/if}
                  {#if allowEditColumns && schema[field]?.editable !== false}
                    <Icon
                      name="pencil"
                      size="S"
                      hoverable
                      color="var(--spectrum-global-color-gray-600)"
                      hoverColor="var(--spectrum-global-color-gray-900)"
                      on:click={e => editColumn(e, field)}
                    />
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
        {#if sortedRows?.length}
          {#each sortedRows as row}
            <div class="spectrum-Table-row" class:clickable={allowClickRows}>
              {#if showEditColumn}
                <div
                  class:noBorderCheckbox={!showHeaderBorder}
                  class="spectrum-Table-cell spectrum-Table-cell--divider spectrum-Table-cell--edit"
                  on:click={e => {
                    if (row.__selectable === false) {
                      return
                    }
                    toggleSelectRow(row)
                    e.stopPropagation()
                  }}
                >
                  <SelectEditRenderer
                    data={row}
                    selected={selectedRows.findIndex(
                      selectedRow => selectedRow._id === row._id
                    ) !== -1}
                    onEdit={e => editRow(e, row)}
                    {allowSelectRows}
                    {allowEditRows}
                  />
                </div>
              {/if}
              {#each fields as field}
                <div
                  class="spectrum-Table-cell"
                  class:spectrum-Table-cell--divider={!!schema[field].divider}
                  style={cellStyles[field]}
                  on:click={() => {
                    if (!schema[field]?.preventSelectRow) {
                      dispatch("click", row)
                      toggleSelectRow(row)
                    }
                  }}
                >
                  <CellRenderer
                    {customRenderers}
                    {row}
                    {snippets}
                    schema={schema[field]}
                    value={deepGet(row, field)}
                    on:clickrelationship
                    on:buttonclick
                  >
                    <slot />
                  </CellRenderer>
                </div>
              {/each}
            </div>
          {/each}
        {:else}
          <div
            class="placeholder"
            class:placeholder--custom={customPlaceholder}
            class:placeholder--no-fields={!fields?.length}
          >
            {#if customPlaceholder}
              <slot name="placeholder" />
            {:else}
              <div class="placeholder-content">
                <Icon
                  name="table"
                  size="XXL"
                  color="var(--spectrum-global-color-gray-600)"
                />
                <div>{placeholderText}</div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/key}

<style>
  /* Wrapper */
  .wrapper {
    position: relative;
    --table-bg: var(--spectrum-global-color-gray-50);
    --table-border: 1px solid var(--spectrum-alias-border-color-mid);
    --cell-padding: var(--spectrum-global-dimension-size-250);
    overflow: auto;
    display: contents;
  }
  .wrapper--quiet {
    --table-bg: var(--spectrum-alias-background-color-transparent);
  }
  .wrapper--compact {
    --cell-padding: var(--spectrum-global-dimension-size-150);
  }

  /* Loading */
  .loading {
    display: flex;
    align-items: center;
    min-height: 100px;
    justify-content: center;
  }

  /* Table */
  .spectrum-Table {
    width: 100%;
    border-radius: 0;
    display: grid;
    overflow: auto;
  }
  .spectrum-Table.no-scroll {
    overflow: visible;
  }

  /* Header */
  .spectrum-Table-head {
    display: contents;
  }
  .spectrum-Table-head > :first-child {
    border-left: 1px solid transparent;
    padding-left: var(--cell-padding);
  }
  .spectrum-Table-head > :last-child {
    border-right: 1px solid transparent;
    padding-right: var(--cell-padding);
  }
  .spectrum-Table-headCell {
    height: var(--header-height);
    position: sticky;
    top: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
    background-color: var(--spectrum-alias-background-color-secondary);
    z-index: 2;
    border-bottom: var(--table-border);
    padding: 0 calc(var(--cell-padding) / 1.33);
    display: flex;
    flex-direction: row;
    justify-content: flex-start;
    align-items: center;
    user-select: none;
    border-top: var(--table-border);
  }
  .spectrum-Table-headCell:first-of-type {
    border-left: var(--table-border);
  }
  .spectrum-Table-headCell:last-of-type {
    border-right: var(--table-border);
  }

  .noBorderHeader {
    border-top: none !important;
    border-right: none !important;
    border-left: none !important;
  }

  .noBorderCheckbox {
    border-top: none !important;
    border-right: none !important;
  }

  .spectrum-Table-headCell--alignCenter {
    justify-content: center;
  }
  .spectrum-Table-headCell--alignRight {
    justify-content: flex-end;
  }
  .spectrum-Table-headCell--edit {
    position: sticky;
    left: 0;
    z-index: 3;
  }
  .spectrum-Table-headCell .title {
    overflow: visible;
    text-overflow: ellipsis;
    display: flex;
    gap: 4px;
  }
  .spectrum-Table-headCell :global(.icon) {
    margin-left: var(
      --spectrum-table-header-sort-icon-gap,
      var(--spectrum-global-dimension-size-125)
    );
  }

  /* Table rows */
  .spectrum-Table-row {
    display: contents;
    cursor: auto;
  }
  .spectrum-Table-row.clickable {
    cursor: pointer;
  }
  .spectrum-Table-row.clickable:hover .spectrum-Table-cell {
    background-color: var(--spectrum-global-color-gray-100);
  }
  .wrapper--quiet .spectrum-Table-row {
    border-left: none;
    border-right: none;
  }
  .spectrum-Table-row > :first-child {
    border-left: var(--table-border);
    padding-left: var(--cell-padding);
  }
  .spectrum-Table-row > :last-child {
    border-right: var(--table-border);
    padding-right: var(--cell-padding);
  }

  /* Table cells */
  .spectrum-Table-cell {
    flex: 1 1 auto;
    padding: 0 calc(var(--cell-padding) / 1.33);
    border-top: none;
    border-bottom: none;
    border-radius: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
    height: var(--row-height);
    display: flex;
    flex-direction: row;
    justify-content: flex-start;
    align-items: center;
    gap: 4px;
    border-bottom: 1px solid var(--spectrum-alias-border-color-mid);
    background-color: var(--table-bg);
    z-index: auto;
    transition: background-color 130ms ease-out;
  }
  .spectrum-Table-cell--edit {
    position: sticky;
    left: 0;
    z-index: 2;
  }

  /* Placeholder  */
  .placeholder {
    display: flex;
    flex-direction: row;
    justify-content: center;
    align-items: center;
    border: var(--table-border);
    border-top: none;
    grid-column: 1 / -1;
    background-color: var(--table-bg);
    padding: 40px;
  }
  .placeholder--no-fields {
    border-top: var(--table-border);
  }
  .placeholder--custom {
    justify-content: flex-start;
  }
  .wrapper--quiet .placeholder {
    border-left: none;
    border-right: none;
  }
  .placeholder-content {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    color: var(
      --spectrum-table-cell-text-color,
      var(--spectrum-alias-text-color)
    );
  }
  .placeholder-content div {
    margin-top: 10px;
    font-size: var(
      --spectrum-table-cell-text-size,
      var(--spectrum-alias-font-size-default)
    );
    text-align: center;
  }
</style>
