/**
 * Reversible display encoding for candidate-controlled source paths inside evidence headers.
 *
 * Percent is escaped first so an original path containing a literal sequence such as `%3C`
 * cannot be confused with an encoded `<`. Angle brackets are the only other encoded characters:
 * they are the framing risk this boundary exists to remove, while leaving ordinary paths readable.
 */
export function encodeEvidenceSourcePath(path: string): string {
  return path.replaceAll("%", "%25").replaceAll("<", "%3C").replaceAll(">", "%3E");
}

/** Rejects an unknown percent escape instead of reconstructing an ambiguous source identity. */
export function decodeEvidenceSourcePath(displayPath: string): string | undefined {
  let decoded = "";
  for (let index = 0; index < displayPath.length; index += 1) {
    const character = displayPath.charAt(index);
    if (character !== "%") {
      decoded += character;
      continue;
    }
    const escape = displayPath.slice(index, index + 3);
    if (escape === "%25") decoded += "%";
    else if (escape === "%3C") decoded += "<";
    else if (escape === "%3E") decoded += ">";
    else return undefined;
    index += 2;
  }
  return decoded;
}
