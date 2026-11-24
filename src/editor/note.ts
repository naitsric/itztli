import { Facet } from "@codemirror/state";

/** The path of the note an editor shows. */
export const notePath = Facet.define<string, string>({ combine: (values) => values[0] ?? "" });
