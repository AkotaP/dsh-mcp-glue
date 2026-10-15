/**
 * Path editors for declaration formats. JSONC/YAML retain document structure; TOML deliberately
 * parses and prints the entire document, preserving values but not comments or formatting.
 * Callers must obtain explicit consent before rewriting an existing TOML file.
 */
import { modify, applyEdits } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import TOML from '@iarna/toml';
import { DeclarationError } from './normalize.js';

/** Formats whose declaration paths can be rewritten. TOML is a lossy text rewrite. */
export const EDITABLE_FORMATS = Object.freeze(['json', 'jsonc', 'toml']);

/** Whether setPath supports this format (not a promise of lossless formatting). */
export const isEditableFormat = format => EDITABLE_FORMATS.includes(format) || format === 'yaml';

/**
 * Rewrite one path. An undefined value deletes it. TOML preserves all other values semantically,
 * but reprints the entire document; the editor enforces consent before any existing-file write.
 */
export function setPath(text, format, path, value) {
  if (format === 'json' || format === 'jsonc') {
    const edits = modify(text, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    return applyEdits(text, edits);
  }
  if (format === 'yaml') {
    const doc = parseDocument(text);
    if (doc.errors.length) throw new DeclarationError('INVALID_DECLARATION');
    if (value === undefined) doc.deleteIn(path);
    else doc.setIn(path, value);
    return doc.toString();
  }
  if (format === 'toml') {
    const doc = TOML.parse(text);
    if (path.length === 0) return TOML.stringify(value === undefined ? {} : value);
    let node = doc;
    for (const key of path.slice(0, -1)) {
      // Never traverse inherited properties (especially __proto__) or invoke their setters.
      if (!Object.hasOwn(node, key) || node[key] === null || typeof node[key] !== 'object') {
        if (value === undefined) return TOML.stringify(doc);
        Object.defineProperty(node, key, { value: Object.create(null), enumerable: true, writable: true, configurable: true });
      }
      node = node[key];
    }
    const key = path[path.length - 1];
    if (value === undefined) delete node[key];
    else Object.defineProperty(node, key, { value, enumerable: true, writable: true, configurable: true });
    return TOML.stringify(doc);
  }
  throw new DeclarationError('UNSUPPORTED_FORMAT');
}
