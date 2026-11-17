import type { Agent } from './forms.js';

/**
 * Signs a Supertest agent in as `userId` through the test-only route (ADR 0017): the same `establishSession` a real
 * login runs, without the auth module's routes, so every module's tests can use signed-in agents from phase 1 on.
 * Create the user first (`createUser` in `test/factories.ts`). Real login and registration are tested only in the
 * auth module's own files.
 */
export async function signIn(agent: Agent, userId: number): Promise<void> {
  const response = await agent.post('/__test/sign-in').send({ userId });
  if (response.status !== 204) {
    throw new Error(
      `test/auth.ts: sign-in as user ${String(userId)} answered ${String(response.status)}, expected 204`,
    );
  }
}
