import { randomUUID } from "node:crypto";

import { authDatabase } from "./lib/auth";

/** Reserve one hosted model call atomically before it leaves the marketplace. */
export async function admitPlatformAiCall(input: {
  subject: string;
  requestId: string;
  platformPath: string;
  perSubjectLimit: number;
  globalLimit: number;
}): Promise<boolean> {
  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('matchplane:platform-ai:global'))",
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      input.subject,
    ]);
    await client.query(
      `DELETE FROM platform_ai_call_admissions
        WHERE created_at < clock_timestamp() - interval '2 hours'`,
    );
    const globalRecent = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM platform_ai_call_admissions
        WHERE created_at >= clock_timestamp() - interval '1 hour'`,
    );
    if (Number(globalRecent.rows[0]?.count ?? 0) >= input.globalLimit) {
      await client.query("ROLLBACK");
      return false;
    }
    const recent = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM platform_ai_call_admissions
        WHERE auth_user_id = $1
          AND created_at >= clock_timestamp() - interval '1 hour'`,
      [input.subject],
    );
    if (Number(recent.rows[0]?.count ?? 0) >= input.perSubjectLimit) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO platform_ai_call_admissions
        (id, auth_user_id, request_id, platform_path)
       VALUES ($1::uuid, $2, $3::uuid, $4)`,
      [randomUUID(), input.subject, input.requestId, input.platformPath],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the admission failure that caused the rollback.
    }
    throw error;
  } finally {
    client.release();
  }
}
