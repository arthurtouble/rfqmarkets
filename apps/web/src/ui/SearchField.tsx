import { useId } from "react";

const SearchIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;

/** A search box in the design system's field style, with a clear button once there is text. */
export function SearchField({ value, onChange, label, placeholder = "Search", autoFocus = false }: { value: string; onChange: (value: string) => void; label: string; placeholder?: string; autoFocus?: boolean }) {
  const id = useId();
  return <div className="rfq-field search-field">
    <label htmlFor={id} className="visually-hidden">{label}</label>
    <div className="rfq-field__box">
      <span className="search-field__icon"><SearchIcon /></span>
      <input id={id} type="search" inputMode="search" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder={placeholder}
        value={value} autoFocus={autoFocus} onChange={event => onChange(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape" && value) { event.preventDefault(); event.stopPropagation(); onChange(""); } }} />
      {value && <button type="button" className="search-field__clear" aria-label="Clear search" onClick={() => onChange("")}>×</button>}
    </div>
  </div>;
}
