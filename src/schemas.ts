import { z, type ZodType } from "zod";
import type { SchemaId } from "./operations.js";

const looseObject = z.record(z.string(), z.unknown());

function envelope(shape: Record<string, ZodType>): ZodType {
  return z.looseObject(shape);
}

const entry = envelope({
  id: z.unknown().optional(),
  title: z.unknown().optional(),
  url: z.unknown().optional(),
});

const entryList = z.union([
  z.array(looseObject),
  envelope({
    _embedded: z.unknown().optional(),
    page: z.unknown().optional(),
    limit: z.unknown().optional(),
    pages: z.unknown().optional(),
    total: z.unknown().optional(),
  }),
]);

const exists = z.union([
  envelope({ exists: z.unknown().optional() }),
  z.record(z.string(), z.unknown()),
]);

const tag = envelope({
  id: z.unknown().optional(),
  label: z.unknown().optional(),
  slug: z.unknown().optional(),
});

const tagList = z.union([z.array(looseObject), tag]);

const annotation = envelope({
  id: z.unknown().optional(),
  text: z.unknown().optional(),
  quote: z.unknown().optional(),
});

const annotationList = z.union([
  z.array(looseObject),
  envelope({ rows: z.unknown().optional(), total: z.unknown().optional() }),
]);

const config = envelope({
  id: z.unknown().optional(),
  items_per_page: z.unknown().optional(),
  language: z.unknown().optional(),
});

const taggingRules = z.union([z.array(looseObject), envelope({})]);

const user = envelope({
  id: z.unknown().optional(),
  username: z.unknown().optional(),
  email: z.unknown().optional(),
});

const userCreated = envelope({
  id: z.unknown().optional(),
  username: z.unknown().optional(),
  default_client: z.unknown().optional(),
  client_id: z.unknown().optional(),
  client_secret: z.unknown().optional(),
});

const info = envelope({
  appname: z.unknown().optional(),
  version: z.unknown().optional(),
  allowed_registration: z.unknown().optional(),
});

const version = z.union([z.string(), envelope({ version: z.unknown().optional() })]);

const ok = envelope({ ok: z.unknown().optional() });

const SCHEMAS: Record<SchemaId, ZodType> = {
  jsonEnvelope: z.unknown(),
  ok,
  entry,
  entryList,
  exists,
  tag,
  tagList,
  annotation,
  annotationList,
  config,
  taggingRules,
  user,
  userCreated,
  info,
  version,
};

export function schemaFor(id: SchemaId): ZodType {
  return SCHEMAS[id];
}
