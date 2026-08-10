/** Pure, versioned catalog data; importing it performs no repository or process I/O. */
export const CLOSED_RUNTIME_FACT_CATALOG_VERSION = 1 as const;

/** Candidate content can select one of these facts, but can never supply or alter its wording. */
export const CLOSED_RUNTIME_FACT_CATALOG = Object.freeze({
  "ecmascript.object_spread.nullish_source_is_noop":
    "ECMAScript object spread copies no properties and does not throw when its source is null or undefined.",
} as const);

export type ClosedRuntimeFactId = keyof typeof CLOSED_RUNTIME_FACT_CATALOG;

export const CLOSED_RUNTIME_FACT_IDS = Object.freeze(
  Object.keys(CLOSED_RUNTIME_FACT_CATALOG) as ClosedRuntimeFactId[],
);

export type ClosedRuntimeFactSide = "H" | "B";

/** A closed fact plus the exact reviewed syntax location that licensed it. */
export type ClosedRuntimeFact = {
  readonly [Id in ClosedRuntimeFactId]: {
    readonly catalogVersion: typeof CLOSED_RUNTIME_FACT_CATALOG_VERSION;
    readonly id: Id;
    readonly statement: (typeof CLOSED_RUNTIME_FACT_CATALOG)[Id];
    readonly source: {
      readonly path: string;
      readonly side: ClosedRuntimeFactSide;
      readonly line: number;
    };
  };
}[ClosedRuntimeFactId];
