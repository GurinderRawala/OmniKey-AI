/**
 * Shared default Skills resolver (docs/skills-contract.md): one fresh store
 * read plus the deterministic matcher per genuine input. Used by both the
 * HTTP preview and agent activation so both apply identical prefix stripping,
 * warnings and all-or-nothing active limits.
 *
 * Failures are always SkillError: store acquisition/read problems become
 * 503 STORE_UNAVAILABLE (fail closed), limit errors propagate unchanged, and
 * anything unexpected becomes a safe 500 INTERNAL_ERROR. Raw errors, names,
 * keywords, instructions and input text are never logged or rethrown.
 */
import {
  SkillError,
  type MatchSkills,
  type ResolveSkillsForInput,
  type SkillStore,
} from './contracts';
import { matchSkills, matchSkillsUnbudgeted } from './matcher';
import {
  createSkillInputResolver,
  getDefaultSkillStore,
  SKILL_ERROR_MESSAGES,
  storeUnavailable,
} from './skillStore';

export interface SkillResolverDeps {
  /** Store factory; defaults to the shared application-database store. */
  getStore?: () => Promise<SkillStore>;
  /** Matcher; defaults to the shared deterministic matcher. */
  match?: MatchSkills;
}

/** Build a resolver bound to a (lazily acquired) store and matcher. */
export function createSkillResolver(deps: SkillResolverDeps = {}): ResolveSkillsForInput {
  const getStore = deps.getStore ?? getDefaultSkillStore;
  const match = deps.match ?? matchSkills;
  return async (subscriptionId, rawText) => {
    let store: SkillStore;
    try {
      store = await getStore();
    } catch (err) {
      if (err instanceof SkillError) throw err;
      throw storeUnavailable();
    }
    try {
      return await createSkillInputResolver(store, match)(subscriptionId, rawText);
    } catch (err) {
      if (err instanceof SkillError) throw err;
      throw new SkillError(500, 'INTERNAL_ERROR', SKILL_ERROR_MESSAGES.INTERNAL_ERROR);
    }
  };
}

/** Default resolver over the shared store: `resolveSkillsForInput(subscriptionId, rawText)`. */
export const resolveSkillsForInput: ResolveSkillsForInput = createSkillResolver();

/**
 * Resolver pair over ONE store: the budgeted default for ordinary input and
 * preview, and an unbudgeted variant for agent steering, whose caller must
 * enforce the active limits on the deduplicated first-snapshot union.
 */
export function createSkillResolvers(getStore?: () => Promise<SkillStore>): {
  ordinary: ResolveSkillsForInput;
  steering: ResolveSkillsForInput;
} {
  return {
    ordinary: createSkillResolver({ getStore }),
    steering: createSkillResolver({ getStore, match: matchSkillsUnbudgeted }),
  };
}

/** Default steering resolver over the shared store (limits NOT applied; see above). */
export const resolveSteeringSkillMatches: ResolveSkillsForInput = createSkillResolver({
  match: matchSkillsUnbudgeted,
});
