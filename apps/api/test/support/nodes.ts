/**
 * The smallest valid Thought node (BIB-25's CHECKs: a body, no title; origin is always named),
 * for fixtures that need some node of a study and don't care which.
 */
export const THOUGHT = { type: 'thought', origin: 'user', body: 'A thought' } as const;
