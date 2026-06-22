// Catalog of the built-in `format` values that JSON Schema (draft 2020-12) defines for
// strings, plus helpers for the content-encoding and `pattern` cases. Each descriptor
// carries a short human label (used in the "Data type" column) and a one-line
// description with a generic example (used in the "Format" column).

export interface FormatDescriptor {
  name: string;
  /** Short label for the "Data type" column (e.g. "date", "email address"). */
  label: string;
  /** One-line human description for the "Format" column. */
  description: string;
  /** A generic example value. */
  example: string;
}

export const STRING_FORMATS: Record<string, FormatDescriptor> = {
  "date-time": {
    name: "date-time",
    label: "timestamp",
    description: "Date and time (ISO 8601 / RFC 3339)",
    example: "2026-06-22T14:30:00Z"
  },
  date: {
    name: "date",
    label: "date",
    description: "Calendar date (ISO 8601 / RFC 3339)",
    example: "2026-06-22"
  },
  time: {
    name: "time",
    label: "time",
    description: "Time of day (ISO 8601 / RFC 3339)",
    example: "14:30:00Z"
  },
  duration: {
    name: "duration",
    label: "duration",
    description: "Time duration (ISO 8601)",
    example: "P3Y6M4DT12H30M"
  },
  email: {
    name: "email",
    label: "email address",
    description: "Email address (RFC 5321)",
    example: "user@example.org"
  },
  "idn-email": {
    name: "idn-email",
    label: "email address (intl.)",
    description: "Internationalized email address (RFC 6531)",
    example: "δοκιμή@παράδειγμα.gr"
  },
  hostname: {
    name: "hostname",
    label: "hostname",
    description: "Internet host name (RFC 1123)",
    example: "data.example.org"
  },
  "idn-hostname": {
    name: "idn-hostname",
    label: "hostname (intl.)",
    description: "Internationalized host name (RFC 5890)",
    example: "παράδειγμα.gr"
  },
  ipv4: {
    name: "ipv4",
    label: "IPv4 address",
    description: "IPv4 network address (RFC 2673)",
    example: "192.0.2.1"
  },
  ipv6: {
    name: "ipv6",
    label: "IPv6 address",
    description: "IPv6 network address (RFC 4291)",
    example: "2001:db8::1"
  },
  uri: {
    name: "uri",
    label: "URI",
    description: "Absolute URI (RFC 3986)",
    example: "https://example.org/x"
  },
  "uri-reference": {
    name: "uri-reference",
    label: "URI reference",
    description: "URI or relative reference (RFC 3986)",
    example: "../record?id=1"
  },
  iri: {
    name: "iri",
    label: "IRI",
    description: "Internationalized URI (RFC 3987)",
    example: "https://例え.jp/項目"
  },
  "iri-reference": {
    name: "iri-reference",
    label: "IRI reference",
    description: "IRI or relative IRI reference (RFC 3987)",
    example: "../項目?id=1"
  },
  uuid: {
    name: "uuid",
    label: "UUID",
    description: "Universally unique identifier (RFC 4122)",
    example: "123e4567-e89b-12d3-a456-426614174000"
  },
  "uri-template": {
    name: "uri-template",
    label: "URI template",
    description: "URI Template (RFC 6570)",
    example: "https://example.org/patients/{id}"
  },
  "json-pointer": {
    name: "json-pointer",
    label: "JSON Pointer",
    description: "JSON Pointer (RFC 6901)",
    example: "/items/0/id"
  },
  "relative-json-pointer": {
    name: "relative-json-pointer",
    label: "relative JSON Pointer",
    description: "Relative JSON Pointer",
    example: "1/name"
  },
  regex: {
    name: "regex",
    label: "regular expression",
    description: "ECMA-262 regular expression",
    example: "^[A-Z]{2}$"
  }
};

/** True when `format` is a JSON Schema built-in string format. */
export function isKnownFormat(format: string | undefined): boolean {
  return !!format && format in STRING_FORMATS;
}

/** Short label for the "Data type" column, e.g. "date", "email address", or the raw name. */
export function formatLabel(format: string | undefined): string {
  if (!format) return "";
  return STRING_FORMATS[format]?.label ?? format;
}

/** One-line "Format" column text with a generic example. */
export function describeFormat(format: string | undefined): string {
  if (!format) return "";
  const d = STRING_FORMATS[format];
  if (!d) return `Custom format "${format}".`;
  return `${d.description} — e.g. ${d.example}`;
}

/** Human description of base64/binary (BLOB) content declared via contentEncoding/contentMediaType. */
export function describeEncodedContent(contentEncoding?: string, contentMediaType?: string): string {
  if (!contentEncoding && !contentMediaType) return "";
  const pieces: string[] = [];
  if (contentEncoding) {
    pieces.push(
      contentEncoding.toLowerCase() === "base64"
        ? "Base64-encoded binary data"
        : `Binary data encoded as ${contentEncoding}`
    );
  }
  if (contentMediaType) pieces.push(`media type ${contentMediaType}`);
  return pieces.join(", ");
}

/** Recognise a handful of common structured-string patterns so the Format cell reads nicely. */
export function describePattern(pattern: string): string {
  const friendly = friendlyPatternName(pattern);
  return friendly ? `${friendly} — pattern ${pattern}` : `Matches pattern ${pattern}`;
}

function friendlyPatternName(pattern: string): string | undefined {
  const p = pattern;
  if (/\\d\{5\}(\(\?:\)|\(|\\-|-)?.*\\d\{4\}/.test(p) || /\^\\d\{5\}/.test(p)) return "US ZIP code";
  if (/\\d\{3\}.*\\d\{2\}.*\\d\{4\}/.test(p)) return "US Social Security Number";
  if (/(\d\{4\}).*(\d\{2\}).*(\d\{2\})/.test(p) && p.includes("/")) return "Date (dd/mm/yyyy)";
  if (/[+]?\\d\{1,3\}.*\\d/.test(p) && /phone|tel/i.test(p)) return "Phone number";
  return undefined;
}
