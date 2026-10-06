import { parseDocument, type Document } from "yaml";
import { createTwoFilesPatch } from "diff";
import { normaliseWorkflow } from "../model/normalise";
import type { NormalisedWorkflow } from "../model/types";

export interface LoadedWorkflow {
  path: string;
  content: string;
  doc: Document;
  model: NormalisedWorkflow;
}

/** Parse once, keep the Document for comment-preserving edits, and derive the model. */
export function loadWorkflow(path: string, content: string): LoadedWorkflow {
  const doc = parseDocument(content, { keepSourceTokens: true, version: "1.2" });
  return { path, content, doc, model: normaliseWorkflow(doc.toJS({ mapAsMap: false })) };
}

export type WorkflowEdit = (doc: Document) => void;

export interface AppliedEdit {
  before: string;
  after: string;
  diff: string;
  /** Comment lines before and after. An edit that loses comments is a bug (CLAUDE.md rule 1). */
  commentsBefore: number;
  commentsAfter: number;
}

export function countComments(text: string): number {
  return text.split("\n").filter((l) => /(^|\s)#(?!\{)/.test(l)).length;
}

/** Apply an edit to a fresh parse of the content, never to the caller's Document, and return the unified diff. */
export function applyEdit(path: string, content: string, edit: WorkflowEdit): AppliedEdit {
  const doc = parseDocument(content, { keepSourceTokens: true, version: "1.2" });
  edit(doc);
  const after = doc.toString({ lineWidth: 0 });
  parseDocument(after); // must still parse
  const diff = createTwoFilesPatch(`a/${path}`, `b/${path}`, content, after, undefined, undefined, { context: 3 });
  return { before: content, after, diff, commentsBefore: countComments(content), commentsAfter: countComments(after) };
}
