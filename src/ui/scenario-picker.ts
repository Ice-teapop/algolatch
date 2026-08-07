export interface ScenarioPickerOption {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly keywords: readonly string[];
}

export interface ScenarioPickerCopy {
  readonly ariaLabel: string;
  readonly emptyLabel: string;
  readonly searchAriaLabel: string;
  readonly searchPlaceholder: string;
  readonly noMatches: string;
}

export interface ScenarioPickerOptions {
  readonly options: readonly ScenarioPickerOption[];
  readonly value: string;
  readonly copy: ScenarioPickerCopy;
  readonly onSelect: (id: string) => void;
}

export interface ScenarioPicker {
  readonly element: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
  destroy(): void;
}

let pickerSequence = 0;

/**
 * Compact renderer-owned scenario picker. The native macOS select menu cannot
 * be sized, searched, or kept inside the workbench, so this component uses the
 * Popover API and a bounded listbox while preserving the scenario id contract.
 */
export function createScenarioPicker(
  ownerDocument: Document,
  options: ScenarioPickerOptions,
): ScenarioPicker {
  assertOptions(options);
  const instanceId = `scenario-picker-${String(++pickerSequence)}`;
  const root = ownerDocument.createElement("div");
  root.className = "scenario-picker";

  const trigger = ownerDocument.createElement("button");
  trigger.type = "button";
  trigger.className = "scenario-picker__trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", `${instanceId}-listbox`);
  trigger.setAttribute("aria-label", options.copy.ariaLabel);
  const triggerLabel = ownerDocument.createElement("span");
  triggerLabel.className = "scenario-picker__trigger-label";
  const disclosure = ownerDocument.createElement("span");
  disclosure.className = "scenario-picker__disclosure";
  disclosure.setAttribute("aria-hidden", "true");
  disclosure.textContent = "⌄";
  trigger.append(triggerLabel, disclosure);

  const popover = ownerDocument.createElement("div");
  popover.className = "scenario-picker__popover";
  popover.setAttribute("popover", "auto");
  popover.setAttribute("aria-label", options.copy.ariaLabel);

  const search = ownerDocument.createElement("input");
  search.type = "search";
  search.className = "scenario-picker__search";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.placeholder = options.copy.searchPlaceholder;
  search.setAttribute("aria-label", options.copy.searchAriaLabel);
  search.setAttribute("aria-controls", `${instanceId}-listbox`);
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-expanded", "true");

  const listbox = ownerDocument.createElement("div");
  listbox.id = `${instanceId}-listbox`;
  listbox.className = "scenario-picker__listbox";
  listbox.setAttribute("role", "listbox");
  listbox.setAttribute("aria-label", options.copy.ariaLabel);

  const empty = ownerDocument.createElement("p");
  empty.className = "scenario-picker__empty";
  empty.setAttribute("role", "status");
  empty.setAttribute("aria-live", "polite");
  empty.textContent = options.copy.noMatches;
  popover.append(search, listbox, empty);
  root.append(trigger, popover);

  let destroyed = false;
  let value = options.value;
  let activeIndex = 0;
  let renderedButtons: readonly HTMLButtonElement[] = Object.freeze([]);

  const selectedLabel = (): string =>
    options.options.find((candidate) => candidate.id === value)?.label ?? options.copy.emptyLabel;

  const updateTrigger = (): void => {
    triggerLabel.textContent = selectedLabel();
    trigger.title = selectedLabel();
  };

  const updateActive = (): void => {
    if (renderedButtons.length === 0) {
      search.removeAttribute("aria-activedescendant");
      return;
    }
    activeIndex = Math.max(0, Math.min(activeIndex, renderedButtons.length - 1));
    renderedButtons.forEach((button, index) => {
      button.dataset.active = index === activeIndex ? "true" : "false";
    });
    const active = renderedButtons[activeIndex];
    if (active === undefined) return;
    search.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  };

  const renderOptions = (): void => {
    const filtered = filterScenarioPickerOptions(options.options, search.value);
    const buttons: HTMLButtonElement[] = [];
    const fragment = ownerDocument.createDocumentFragment();
    if (search.value.trim().length === 0) {
      const clearButton = optionButton(
        ownerDocument,
        `${instanceId}-option-none`,
        "",
        options.copy.emptyLabel,
        value === "",
      );
      buttons.push(clearButton);
      fragment.append(clearButton);
    }

    for (const [groupLabel, groupOptions] of groupScenarioPickerOptions(filtered)) {
      const group = ownerDocument.createElement("section");
      group.className = "scenario-picker__group";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", groupLabel);
      const heading = ownerDocument.createElement("div");
      heading.className = "scenario-picker__group-label";
      heading.setAttribute("aria-hidden", "true");
      heading.textContent = groupLabel;
      group.append(heading);
      for (const item of groupOptions) {
        const button = optionButton(
          ownerDocument,
          `${instanceId}-option-${safeDomId(item.id)}`,
          item.id,
          item.label,
          item.id === value,
        );
        buttons.push(button);
        group.append(button);
      }
      fragment.append(group);
    }

    renderedButtons = Object.freeze(buttons);
    listbox.replaceChildren(fragment);
    empty.hidden = renderedButtons.length > 0;
    activeIndex = renderedButtons.findIndex((button) => button.dataset.scenarioId === value);
    if (activeIndex < 0) activeIndex = 0;
    updateActive();
  };

  const isOpen = (): boolean => {
    try {
      return popover.matches(":popover-open") || popover.dataset.fallbackOpen === "true";
    } catch {
      return popover.dataset.fallbackOpen === "true";
    }
  };

  const positionPopover = (): void => {
    if (!isOpen()) return;
    const view = ownerDocument.defaultView;
    if (view === null) return;
    const anchor = trigger.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const width = Math.min(Math.max(anchor.width, 260), view.innerWidth - margin * 2);
    const maximumHeight = Math.min(320, view.innerHeight - margin * 2);
    const availableBelow = view.innerHeight - anchor.bottom - margin;
    const top =
      availableBelow >= Math.min(maximumHeight, 220)
        ? anchor.bottom + gap
        : Math.max(margin, anchor.top - maximumHeight - gap);
    const left = Math.max(margin, Math.min(anchor.left, view.innerWidth - width - margin));
    popover.style.setProperty("--scenario-picker-left", `${String(left)}px`);
    popover.style.setProperty("--scenario-picker-top", `${String(top)}px`);
    popover.style.setProperty("--scenario-picker-width", `${String(width)}px`);
    popover.style.setProperty("--scenario-picker-max-height", `${String(maximumHeight)}px`);
  };

  const close = (restoreFocus: boolean): void => {
    if (!isOpen()) return;
    if (typeof popover.hidePopover === "function") popover.hidePopover();
    else delete popover.dataset.fallbackOpen;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };

  const open = (): void => {
    if (destroyed || isOpen()) return;
    search.value = "";
    renderOptions();
    if (typeof popover.showPopover === "function") popover.showPopover();
    else popover.dataset.fallbackOpen = "true";
    trigger.setAttribute("aria-expanded", "true");
    positionPopover();
    search.focus({ preventScroll: true });
  };

  const select = (nextValue: string): void => {
    if (nextValue !== "" && !options.options.some((candidate) => candidate.id === nextValue)) {
      return;
    }
    value = nextValue;
    updateTrigger();
    options.onSelect(nextValue);
    close(true);
  };

  const moveActive = (nextIndex: number): void => {
    if (renderedButtons.length === 0) return;
    activeIndex = (nextIndex + renderedButtons.length) % renderedButtons.length;
    updateActive();
  };

  const onTriggerClick = (): void => {
    if (isOpen()) close(true);
    else open();
  };
  const onTriggerKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open();
    moveActive(event.key === "ArrowDown" ? 0 : renderedButtons.length - 1);
  };
  const onSearchInput = (): void => {
    activeIndex = 0;
    renderOptions();
  };
  const onSearchKeydown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveActive(event.key === "Home" ? 0 : renderedButtons.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selected = renderedButtons[activeIndex]?.dataset.scenarioId;
      if (selected !== undefined) select(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  };
  const onListboxClick = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "[data-scenario-id]",
    );
    if (target !== null && target !== undefined) select(target.dataset.scenarioId ?? "");
  };
  const onToggle = (): void => {
    trigger.setAttribute("aria-expanded", isOpen() ? "true" : "false");
  };
  const onViewportChange = (): void => positionPopover();

  trigger.addEventListener("click", onTriggerClick);
  trigger.addEventListener("keydown", onTriggerKeydown);
  search.addEventListener("input", onSearchInput);
  search.addEventListener("keydown", onSearchKeydown);
  listbox.addEventListener("click", onListboxClick);
  popover.addEventListener("toggle", onToggle);
  ownerDocument.addEventListener("scroll", onViewportChange, true);
  ownerDocument.defaultView?.addEventListener("resize", onViewportChange);
  updateTrigger();
  renderOptions();

  return Object.freeze({
    element: root,
    getValue(): string {
      return value;
    },
    setValue(nextValue: string): void {
      if (nextValue !== "" && !options.options.some((candidate) => candidate.id === nextValue)) {
        throw new RangeError(`未知案例：${nextValue}`);
      }
      value = nextValue;
      updateTrigger();
      if (isOpen()) renderOptions();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      close(false);
      trigger.removeEventListener("click", onTriggerClick);
      trigger.removeEventListener("keydown", onTriggerKeydown);
      search.removeEventListener("input", onSearchInput);
      search.removeEventListener("keydown", onSearchKeydown);
      listbox.removeEventListener("click", onListboxClick);
      popover.removeEventListener("toggle", onToggle);
      ownerDocument.removeEventListener("scroll", onViewportChange, true);
      ownerDocument.defaultView?.removeEventListener("resize", onViewportChange);
      root.remove();
    },
  });
}

export function filterScenarioPickerOptions(
  options: readonly ScenarioPickerOption[],
  query: string,
): readonly ScenarioPickerOption[] {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return Object.freeze([...options]);
  return Object.freeze(
    options.filter((option) => {
      const haystack = normalizeSearchText(
        [option.label, option.group, option.id, ...option.keywords].join(" "),
      );
      return tokens.every((token) => haystack.includes(token));
    }),
  );
}

export function groupScenarioPickerOptions(
  options: readonly ScenarioPickerOption[],
): readonly (readonly [string, readonly ScenarioPickerOption[]])[] {
  const groups = new Map<string, ScenarioPickerOption[]>();
  for (const option of options) {
    const group = groups.get(option.group) ?? [];
    group.push(option);
    groups.set(option.group, group);
  }
  return Object.freeze(
    [...groups.entries()].map(([label, items]) =>
      Object.freeze([label, Object.freeze(items)] as const),
    ),
  );
}

function optionButton(
  ownerDocument: Document,
  id: string,
  scenarioId: string,
  label: string,
  selected: boolean,
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = "scenario-picker__option";
  button.dataset.scenarioId = scenarioId;
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", selected ? "true" : "false");
  button.tabIndex = -1;
  const marker = ownerDocument.createElement("span");
  marker.className = "scenario-picker__option-marker";
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = selected ? "✓" : "";
  const text = ownerDocument.createElement("span");
  text.className = "scenario-picker__option-label";
  text.textContent = label;
  button.append(marker, text);
  return button;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-");
}

function assertOptions(options: ScenarioPickerOptions): void {
  const ids = new Set<string>();
  for (const option of options.options) {
    if (option.id.length === 0 || ids.has(option.id)) {
      throw new TypeError("ScenarioPicker option id 必须非空且唯一");
    }
    if (option.label.trim().length === 0 || option.group.trim().length === 0) {
      throw new TypeError("ScenarioPicker option label 与 group 必须是非空文本");
    }
    ids.add(option.id);
  }
  if (options.value !== "" && !ids.has(options.value)) {
    throw new RangeError(`未知案例：${options.value}`);
  }
}
