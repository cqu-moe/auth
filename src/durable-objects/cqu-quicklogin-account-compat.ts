import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

// Production has an existing v3 namespace for this retired class. Keep the
// export so dependent Durable Objects remain deployable without restoring its
// binding or Quicklogin behavior, and without deleting historical state.
export class CquQuickloginAccountDO extends DurableObject<Env> {}
