import { createDatabase } from "@netlify/database";
import * as schema from "./schema";

export const db = createDatabase({ schema });
export * from "./schema";
