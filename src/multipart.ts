export interface Part {
  name: string;
  filename: string | undefined;
  body: Buffer;
}

const DASHES = Buffer.from("--");
const CRLF = Buffer.from("\r\n");
const BLANK = "\r\n\r\n";

export function boundaryOf(contentType: string | undefined): string | undefined {
  if (contentType === undefined || !/^multipart\/form-data\b/i.test(contentType.trim())) {
    return undefined;
  }
  const quoted = /;\s*boundary="([^"]+)"/i.exec(contentType);
  if (quoted?.[1] !== undefined) {
    return quoted[1];
  }
  const bare = /;\s*boundary=([^;]+)/i.exec(contentType);
  const value = bare?.[1]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function valueOf(headers: string, key: string): string | undefined {
  const quoted = new RegExp(`;\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i").exec(headers);
  if (quoted?.[1] !== undefined) {
    return quoted[1].replace(/\\(.)/g, "$1");
  }
  const bare = new RegExp(`;\\s*${key}\\s*=\\s*([^;\\r\\n]+)`, "i").exec(headers);
  return bare?.[1]?.trim();
}

function dispositionIn(headers: string): { name: string; filename: string | undefined } | undefined {
  const line = headers
    .split("\r\n")
    .find((entry) => /^content-disposition\s*:/i.test(entry));
  if (line === undefined) {
    return undefined;
  }
  const name = valueOf(line, "name");
  return name === undefined ? undefined : { name, filename: valueOf(line, "filename") };
}

export function parseMultipart(body: Buffer, boundary: string): Part[] {
  const delimiter = Buffer.concat([CRLF, DASHES, Buffer.from(boundary)]);
  const framed = Buffer.concat([CRLF, body]);
  let at = framed.indexOf(delimiter);
  if (at === -1) {
    throw new Error("it carried no part matching its own boundary");
  }
  const parts: Part[] = [];
  while (at !== -1) {
    let cursor = at + delimiter.length;
    if (framed.subarray(cursor, cursor + 2).equals(DASHES)) {
      return parts;
    }
    while (framed[cursor] === 0x20 || framed[cursor] === 0x09) {
      cursor += 1;
    }
    if (!framed.subarray(cursor, cursor + 2).equals(CRLF)) {
      throw new Error("a part header did not follow its boundary");
    }
    cursor += 2;
    const headEnd = framed.indexOf(BLANK, cursor, "latin1");
    if (headEnd === -1) {
      throw new Error("a part carried no header block");
    }
    const disposition = dispositionIn(framed.subarray(cursor, headEnd).toString("utf8"));
    const next = framed.indexOf(delimiter, headEnd + BLANK.length);
    if (next === -1) {
      throw new Error("a part was never closed");
    }
    if (disposition !== undefined) {
      parts.push({ ...disposition, body: framed.subarray(headEnd + BLANK.length, next) });
    }
    at = next;
  }
  throw new Error("the last part was never closed");
}
