import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

interface SelectOption {
  value: string;
  label: string;
  disabled: boolean;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export interface SelectProps {
  children: ReactNode;
  value?: string | number | readonly string[] | undefined;
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  className?: string;
  title?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function readOptions(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === "option") {
      const props = child.props as {
        value?: string | number;
        disabled?: boolean;
        children?: ReactNode;
      };
      const label = nodeText(props.children).replace(/\s+/g, " ").trim();
      options.push({
        value: String(props.value ?? label),
        label,
        disabled: props.disabled === true,
      });
      return;
    }
    if (child.type === "optgroup") {
      const props = child.props as { children?: ReactNode };
      options.push(...readOptions(props.children));
    }
  });
  return options;
}

/**
 * A styled, keyboard-accessible replacement for the app's single-value selects.
 * The small native-compatible onChange surface keeps existing form handlers
 * unchanged: they can continue to read `event.target.value`.
 */
export function Select({
  children,
  value,
  onChange,
  disabled = false,
  required = false,
  id,
  name,
  className = "",
  title,
  ...aria
}: SelectProps): React.JSX.Element {
  const reactId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const updatePositionRef = useRef<() => void>(() => undefined);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition>({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 280,
  });
  const options = useMemo(() => readOptions(children), [children]);
  const currentValue = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  const selectedIndex = options.findIndex((option) => option.value === currentValue);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const menuId = `${id ?? reactId}-menu`;

  function firstEnabled(from: number, direction: 1 | -1, wrap = true): number {
    if (options.length === 0) return -1;
    let index = from;
    for (let count = 0; count < options.length; count += 1) {
      index += direction;
      if (wrap) index = (index + options.length) % options.length;
      if (!wrap && (index < 0 || index >= options.length)) return -1;
      if (!options[index]?.disabled) return index;
    }
    return -1;
  }

  function openMenu(direction: 1 | -1 = 1): void {
    if (disabled || options.length === 0) return;
    const initial =
      selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : direction === 1
          ? firstEnabled(-1, 1)
          : firstEnabled(options.length, -1);
    setActiveIndex(initial);
    setOpen(true);
  }

  function closeMenu(restoreFocus = false): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function choose(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== currentValue) {
      onChange?.({
        target: { value: option.value, name },
        currentTarget: { value: option.value, name },
      } as ChangeEvent<HTMLSelectElement>);
    }
    closeMenu(true);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = (): void => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const gutter = 8;
      const gap = 6;
      const availableBelow = window.innerHeight - rect.bottom - gutter - gap;
      const availableAbove = rect.top - gutter - gap;
      const contentHeight = Math.min(menu.scrollHeight || options.length * 40 + 12, 320);
      const openAbove =
        availableBelow < Math.min(contentHeight, 180) && availableAbove > availableBelow;
      const maxHeight = Math.max(96, Math.min(320, openAbove ? availableAbove : availableBelow));
      const height = Math.min(contentHeight, maxHeight);
      const width = Math.min(
        Math.max(rect.width, 180),
        Math.max(180, window.innerWidth - gutter * 2),
      );
      const left = Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter));
      const top = openAbove
        ? Math.max(gutter, rect.top - height - gap)
        : Math.min(rect.bottom + gap, window.innerHeight - height - gutter);
      setPosition({ top, left, width, maxHeight });
    };
    updatePositionRef.current = updatePosition;
    updatePosition();
    menuRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onScroll = (event: Event): void => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect || rect.bottom <= 0 || rect.top >= window.innerHeight) {
        closeMenu();
        return;
      }
      // Focus management and anchor navigation can finish scrolling just after
      // the menu opens. Keep the menu attached instead of treating that trailing
      // scroll event as an intent to dismiss it.
      updatePositionRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document
      .getElementById(`${menuId}-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, menuId, open]);

  useEffect(
    () => () => {
      if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
    },
    [],
  );

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(event.key === "ArrowDown" ? 1 : -1);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = firstEnabled(activeIndex, event.key === "ArrowDown" ? 1 : -1);
      if (next >= 0) setActiveIndex(next);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? firstEnabled(-1, 1) : firstEnabled(options.length, -1);
      if (next >= 0) setActiveIndex(next);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const query = `${typeaheadRef.current}${event.key.toLocaleLowerCase()}`;
      typeaheadRef.current = query;
      if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = window.setTimeout(() => {
        typeaheadRef.current = "";
      }, 600);
      const match = options.findIndex(
        (option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(query),
      );
      if (match >= 0) setActiveIndex(match);
    }
  }

  const menu = open ? (
    <div
      ref={menuRef}
      id={menuId}
      className="select-menu"
      role="listbox"
      tabIndex={-1}
      aria-activedescendant={activeIndex >= 0 ? `${menuId}-option-${activeIndex}` : undefined}
      aria-labelledby={aria["aria-labelledby"]}
      aria-label={aria["aria-label"]}
      onKeyDown={onMenuKeyDown}
      style={{
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
    >
      {options.map((option, index) => (
        <div
          id={`${menuId}-option-${index}`}
          key={`${option.value}-${index}`}
          className={`select-option${index === activeIndex ? " active" : ""}${
            index === selectedIndex ? " selected" : ""
          }`}
          role="option"
          aria-selected={index === selectedIndex}
          aria-disabled={option.disabled || undefined}
          title={option.label}
          onPointerMove={() => {
            if (!option.disabled && activeIndex !== index) setActiveIndex(index);
          }}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => choose(index)}
        >
          <span className="select-option-label">{option.label}</span>
          <span className="select-option-check" aria-hidden="true">
            {index === selectedIndex && <Check />}
          </span>
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div className={`select-control${disabled ? " disabled" : ""}`}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`select-trigger ${className}`.trim()}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-required={required || undefined}
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        aria-describedby={aria["aria-describedby"]}
        title={title ?? selected?.label}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`select-value${selected ? "" : " placeholder"}`}>
          {selected?.label ?? "请选择"}
        </span>
        <ChevronDown className="select-chevron" aria-hidden="true" />
      </button>
      {name && <input type="hidden" name={name} value={currentValue} />}
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
