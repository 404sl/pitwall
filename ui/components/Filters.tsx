import {
  FILTER_KEYS,
  FILTER_NONE,
  SORT_KEYS,
  sortKeyOf,
  type FilterKey,
  type FilterOptions,
  type FilterState,
  type SortKey,
} from "../model.js";
import { fill } from "../format.js";
import { boardHref } from "../routes.js";
import { strings } from "../strings.js";

const FIELD_LABEL: Record<FilterKey, string> = {
  project: strings.filters.project,
  type: strings.filters.type,
  priority: strings.filters.priority,
  epic: strings.filters.epic,
  owner: strings.filters.owner,
};

const NONE_LABEL: Partial<Record<FilterKey, string>> = {
  type: strings.filters.none.type,
  priority: strings.filters.none.priority,
  epic: strings.filters.none.epic,
  owner: strings.filters.none.owner,
};

const PHRASE: Record<FilterKey, string> = {
  project: strings.filters.phrase.project,
  type: strings.filters.phrase.type,
  priority: strings.filters.phrase.priority,
  epic: strings.filters.phrase.epic,
  owner: strings.filters.phrase.owner,
};

const SORT_LABEL: Record<SortKey, string> = {
  owner: strings.filters.sortOwner,
  reporter: strings.filters.sortReporter,
};

export function activeKeys(filter: FilterState): FilterKey[] {
  return FILTER_KEYS.filter((key) => filter[key] !== undefined);
}

function unknownOf(key: FilterKey, value: string | undefined, options: FilterOptions): string | undefined {
  if (value === undefined || value === FILTER_NONE || options[key].some((option) => option.value === value)) {
    return undefined;
  }
  return value;
}

function labelOf(key: FilterKey, value: string, options: FilterOptions): string {
  if (value === FILTER_NONE) {
    return NONE_LABEL[key] ?? value;
  }
  const unknown = unknownOf(key, value, options);
  if (unknown !== undefined) {
    return fill(strings.filters.unknown, { value: unknown });
  }
  return options[key].find((option) => option.value === value)?.label ?? value;
}

export function filterPhrases(filter: FilterState, options: FilterOptions): string[] {
  return activeKeys(filter).map((key) => {
    const value = filter[key] as string;
    const label = labelOf(key, value, options);
    return value === FILTER_NONE ? label : fill(PHRASE[key], { value: label });
  });
}

export function filterSentence(filter: FilterState, options: FilterOptions): string {
  return fill(strings.filters.empty, {
    filters: filterPhrases(filter, options).join(strings.filters.separator),
  });
}

function apply(filter: FilterState, sort: SortKey | undefined, key: FilterKey, value: string): void {
  const next: FilterState = { ...filter };
  if (value === "") {
    delete next[key];
  } else {
    next[key] = value;
  }
  window.location.hash = boardHref(next, sort);
}

function Field({
  filter,
  sort,
  options,
  name,
}: {
  filter: FilterState;
  sort?: SortKey;
  options: FilterOptions;
  name: FilterKey;
}) {
  const value = filter[name];
  const none = NONE_LABEL[name];
  const unknown = unknownOf(name, value, options);
  return (
    <div className="pw-filters__field">
      <label className="pw-filters__label" htmlFor={`filter-${name}`}>
        {FIELD_LABEL[name]}
      </label>
      <select
        className="pw-select"
        id={`filter-${name}`}
        value={value ?? ""}
        onChange={(event) => apply(filter, sort, name, event.target.value)}
      >
        <option value="">{strings.filters.all}</option>
        {options[name].map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {none === undefined ? null : <option value={FILTER_NONE}>{none}</option>}
        {unknown === undefined ? null : (
          <option value={unknown}>{fill(strings.filters.unknown, { value: unknown })}</option>
        )}
      </select>
    </div>
  );
}

function Sort({ filter, sort }: { filter: FilterState; sort?: SortKey }) {
  return (
    <div className="pw-filters__field">
      <label className="pw-filters__label" htmlFor="board-sort">
        {strings.filters.sort}
      </label>
      <select
        className="pw-select"
        id="board-sort"
        value={sort ?? ""}
        onChange={(event) => {
          window.location.hash = boardHref(filter, sortKeyOf(event.target.value));
        }}
      >
        <option value="">{strings.filters.sortDefault}</option>
        {SORT_KEYS.map((key) => (
          <option key={key} value={key}>
            {SORT_LABEL[key]}
          </option>
        ))}
      </select>
    </div>
  );
}

interface FiltersProps {
  filter: FilterState;
  sort?: SortKey;
  options: FilterOptions;
  shown: number;
  total: number;
}

export function Filters({ filter, sort, options, shown, total }: FiltersProps) {
  const active = activeKeys(filter).length > 0;
  return (
    <section className="pw-filters" aria-label={strings.filters.region}>
      <div className="pw-filters__fields">
        {FILTER_KEYS.map((name) => (
          <Field key={name} filter={filter} sort={sort} options={options} name={name} />
        ))}
        {active ? (
          <a className="pw-link pw-filters__clear" href={boardHref({}, sort)}>
            {strings.filters.clear}
          </a>
        ) : null}
        <Sort filter={filter} sort={sort} />
      </div>
      {active ? (
        <p className="pw-notice pw-filters__state" role="status">
          {`${strings.filters.active} ${filterPhrases(filter, options).join(strings.filters.separator)}`}
          {strings.filters.dash}
          {fill(strings.filters.activeCount, { shown: String(shown), total: String(total) })}
        </p>
      ) : null}
    </section>
  );
}
