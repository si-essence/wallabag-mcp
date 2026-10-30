import { z } from "zod";
import { confirmField } from "./confirm.js";
import { fixedError } from "./zod-messages.js";

export { confirmField };

const actionError = fixedError(
  "action must be a published Wallabag operation for this tool, or help",
);

const primitive = z.union([z.string(), z.number(), z.boolean()]);

export const stringMapField = z
  .record(z.string().min(1).max(100), z.union([primitive, z.array(primitive)]))
  .optional()
  .describe("Path or query parameters keyed by the Express parameter name.");

export const bodyField = z
  .union([z.record(z.string().min(1).max(100), z.unknown()), z.array(z.unknown())])
  .optional()
  .describe("JSON body for the Wallabag operation. Secrets are redacted in output.");

export function actionField(actions: [string, ...string[]]): z.ZodType<string> {
  return z.enum(actions, { error: actionError }).describe("Wallabag operation to call, or help.");
}

export function toolInputSchema(actions: [string, ...string[]], writes: boolean) {
  const names = ["help", ...actions.filter((name) => name !== "help")] as [string, ...string[]];
  const shape = {
    action: actionField(names),
    target: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("With action help, the action whose parameters to describe."),
    params: stringMapField.describe("Express path parameters, such as id."),
    query: stringMapField.describe("Query parameters."),
    body: bodyField,
    ...(writes ? { confirm: confirmField } : {}),
  };
  return z.object(shape);
}

export type ToolInput = {
  action: string;
  target?: string | undefined;
  params?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  query?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  body?: unknown;
  confirm?: true | undefined;
};
