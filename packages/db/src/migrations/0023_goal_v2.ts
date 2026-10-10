import { type Kysely, sql } from "kysely";

/**
 * F-U7 (D-345): the goal becomes one aggressiveness choice with a model tier,
 * the screened-lane opt-in and excluded tokens; the strategy template, the
 * risk preset and the WMON fields are gone. Every goal saved before this is
 * reshaped in place: Conservative (D-345), the reasoning model as a tier
 * (Standard to Medium, Deep to High), no opt-in, no exclusions, the WMON
 * share limit as the one-token limit, every other setting carried over. The
 * strategy epoch is not bumped (D-281 stands: only an owner's save does). The
 * stored configuration is left as it was; the goal store translates a
 * reshaped goal afresh when it reads one, and the next save stores it anew.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update platform.agent_goals
    set goal = jsonb_build_object(
      'aggressiveness', 'CONSERVATIVE',
      'modelTier', case when goal->>'reasoningModel' = 'DEEP' then 'HIGH' else 'MEDIUM' end,
      'screenedOptIn', false,
      'excludedTokens', '[]'::jsonb,
      'stricterLimits', jsonb_build_object(
        'maxTradeBps', coalesce(goal->'stricterLimits'->'maxTradeBps', 'null'::jsonb),
        'maxPositionBps', coalesce(goal->'stricterLimits'->'maxWmonShareBps', 'null'::jsonb),
        'minUsdcShareBps', coalesce(goal->'stricterLimits'->'minUsdcShareBps', 'null'::jsonb),
        'maxSlippageBps', coalesce(goal->'stricterLimits'->'maxSlippageBps', 'null'::jsonb),
        'maxTradesPer24h', coalesce(goal->'stricterLimits'->'maxTradesPer24h', 'null'::jsonb)
      ),
      'research', coalesce(goal->'research', '{"intensity":"LIGHT","dailyBudgetUsdcE6":"1000000"}'::jsonb),
      'creditReserveUsdcE6', coalesce(goal->'creditReserveUsdcE6', '"1000000"'::jsonb),
      'planChanges', coalesce(goal->'planChanges', '"ASK_FIRST"'::jsonb)
    )
    where goal ? 'template' and not (goal ? 'aggressiveness')
  `.execute(db);
}

export async function down(): Promise<void> {
  // The old shape cannot be rebuilt: the preset and the template are not kept.
}
