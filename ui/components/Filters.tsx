import { Fragment } from "react";
import {
  FILTER_KEYS,
  FILTER_NONE,
  type FilterKey,
  type FilterOptions,
  type FilterState,
} from "../model.js";
import { fill } from "../format.js";
import { boardHref } from "../routes.js";
import { strings } from "../strings.js";

const FIELD_LABEL: Record<FilterKey, string> = {
  project: strings.filters.project,
  type: strings.filters.type,
  priority: strings.filters.priority,
  epic: strings.filters.epic,
};

const NONE_LABEL: Partial<Record<FilterKey, string>> = {
  type: strings.filters.none.type,
  priority: strings.filters.none.priority,
  epic: strings.filters.none.epic,
};

const PHRASE: Record<FilterKey, string> = {
  project: strings.filters.phrase.project,
  type: strings.filters.phrase.type,
  priority: strings.filters.phrase.priority,
  epic: strings.filters.phrase.epic,
};

export function activeKeys(filter: FilterState): FilterKey[] {
  return FILTER_KEYS.filter((key) => filter[key] !== undefined);
}

function labelOf(key: FilterKey, value: string, options: FilterOptions): string {
  if (value === FILTER_NONE) {
    return NONE_LABEL[key] ?? value;
  }
  return options[key].find((option) => option.value === value)?.label ?? value;
}

export function filterLabels(filter: FilterState, options: FilterOptions): string[] {
  return activeKeys(filter).map((key) => labelOf(key, filter[key] as string, options));
}

export function filterSentence(filter: FilterState, options: FilterOptions): string {
  const phrases = activeKeys(filter).map((key) => {
    const value = filter[key] as string;
    const label = labelOf(key, value, options);
    return value === FILTER_NONE ? label : fill(PHRASE[key], { value: label });
  });
  return fill(strings.filters.empty, { filters: phrases.join(strings.filters.separator) });
}

function apply(filter: FilterState, key: FilterKey, value: string): void {
  const next: FilterState = { ...filter };
  if (value === "") {
    delete next[key];
  } else {
    next[key] = value;
  }
  window.location.hash = boardHref(next);
}

function Field({ filter, options, name }: { filter: FilterState; options: FilterOptions; name: FilterKey }) {
  const value = filter[name];
  const none = NONE_LABEL[name];
  const unknown =
    value === undefined || value === FILTER_NONE || options[name].some((option) => option.value === value)
      ? undefined
      : value;
  return (
    <div className="pw-filters__field">
      <label className="pw-filters__label" htmlFor={`filter-${name}`}>
        {FIELD_LABEL[name]}
      </label>
      <select
        className="pw-filters__select"
        id={`filter-${name}`}
        value={value ?? ""}
        disabled={options[name].length === 0}
        onChange={(event) => apply(filter, name, event.target.value)}
      >
        <option value="">{strings.filters.all}</option>
        {options[name].map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {none === undefined ? null : <option value={FILTER_NONE}>{none}</option>}
        {unknown === undefined ? null : <option value={unknown}>{unknown}</option>}
      </select>
    </div>
  );
}

interface FiltersProps {
  filter: FilterState;
  options: FilterOptions;
  shown: number;
  total: number;
}

export function Filters({ filter, options, shown, total }: FiltersProps) {
  const active = activeKeys(filter);
  return (
    <section className="pw-filters" aria-labelledby="filters-label">
      <h2 className="pw-sr" id="filters-label">
        {strings.filters.legend}
      </h2>
      <div className="pw-filters__controls">
        {FILTER_KEYS.map((name) => (
          <Field key={name} filter={filter} options={options} name={name} />
        ))}
        {active.length === 0 ? null : (
          <a className="pw-link pw-filters__clear" href={boardHref({})}>
            {strings.filters.clear}
          </a>
        )}
      </div>
      {active.length === 0 ? null : (
        <p className="pw-notice pw-notice--filters" role="status">
          {`${strings.filters.active} `}
          {filterLabels(filter, options).map((label, index) => (
            <Fragment key={label}>
              {index === 0 ? null : strings.filters.separator}
              <span className="pw-reason__token">{label}</span>
            </Fragment>
          ))}
          {strings.filters.dash}
          {fill(strings.filters.activeCount, { shown: String(shown), total: String(total) })}
        </p>
      )}
    </section>
  );
}
