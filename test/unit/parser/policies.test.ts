/** Row level security policies: command, permissive/restrictive, roles, and display expressions. */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PolicyObject } from '../../../src/model.js';
import { loadParser } from '../../../src/parser/index.js';
import { attributes, keys, objectAt, parse } from './helpers.js';

beforeAll(loadParser);

type PolicyAttributes = Omit<
  PolicyObject,
  'key' | 'source' | 'kind' | 'expect' | 'schema' | 'table'
>;

describe('CREATE POLICY', () => {
  it.each<[string, string, PolicyAttributes]>([
    [
      'FOR ALL TO authenticated with USING and WITH CHECK',
      `create policy "Users manage own todos" on todos for all to authenticated
         using (auth.uid() = user_id) with check (auth.uid() = user_id);`,
      {
        name: 'Users manage own todos',
        command: 'ALL',
        permissive: true,
        roles: ['authenticated'],
        using: 'auth.uid() = user_id',
        withCheck: 'auth.uid() = user_id',
      },
    ],
    [
      'AS RESTRICTIVE (protobuf omits permissive: false)',
      'create policy only_active on todos as restrictive for select using (not archived);',
      {
        name: 'only_active',
        command: 'SELECT',
        permissive: false,
        roles: ['public'],
        using: 'NOT (archived)',
        withCheck: null,
      },
    ],
    [
      'several roles, sorted',
      'create policy staff_read on todos for select to service_role, authenticated, anon using (true);',
      {
        name: 'staff_read',
        command: 'SELECT',
        permissive: true,
        roles: ['anon', 'authenticated', 'service_role'],
        using: 'true',
        withCheck: null,
      },
    ],
    [
      'no TO clause means PUBLIC',
      'create policy anyone_insert on todos for insert with check (true);',
      {
        name: 'anyone_insert',
        command: 'INSERT',
        permissive: true,
        roles: ['public'],
        using: null,
        withCheck: 'true',
      },
    ],
    [
      'special role names',
      'create policy mine on todos for update to public, current_user, session_user using (owner = current_user);',
      {
        name: 'mine',
        command: 'UPDATE',
        permissive: true,
        roles: ['current_user', 'public', 'session_user'],
        using: 'owner = CURRENT_USER',
        withCheck: null,
      },
    ],
    [
      'the (select auth.uid()) performance pattern',
      'create policy own_delete on todos for delete to authenticated using ((select auth.uid()) = user_id);',
      {
        name: 'own_delete',
        command: 'DELETE',
        permissive: true,
        roles: ['authenticated'],
        using: '((SELECT auth.uid())) = user_id',
        withCheck: null,
      },
    ],
  ])('%s', (_label, sql, expected) => {
    const result = parse(sql);
    expect(result.notes).toEqual([]);
    expect(result.objects.map(attributes)).toEqual([
      { kind: 'policy', expect: 'present', schema: 'public', table: 'todos', ...expected },
    ]);
  });

  it('keeps quoted policy and table names verbatim, and the table schema', () => {
    const result = parse(
      'create policy "Avatar images are public" on storage."Objects" for select using (bucket_id = \'avatars\');',
    );
    expect(keys(result)).toEqual(['policy:storage.Objects.Avatar images are public']);
  });
});

describe('ALTER POLICY', () => {
  it('on its own asserts only what it changes', () => {
    const result = parse(
      'alter policy own_delete on todos to authenticated, anon using (user_id = auth.uid());',
    );
    expect(result.objects.map(attributes)).toEqual([
      {
        kind: 'policy',
        expect: 'present',
        schema: 'public',
        table: 'todos',
        name: 'own_delete',
        command: null,
        permissive: null,
        roles: ['anon', 'authenticated'],
        using: 'user_id = auth.uid()',
        withCheck: null,
      },
    ]);
  });

  it('after CREATE POLICY in the same file, updates the created policy', () => {
    const result = parse(`
      create policy p on todos for update to authenticated using (true) with check (true);
      alter policy p on todos with check (owner_id = auth.uid());`);
    expect(attributes(objectAt(result, 'policy:public.todos.p'))).toEqual({
      kind: 'policy',
      expect: 'present',
      schema: 'public',
      table: 'todos',
      name: 'p',
      command: 'UPDATE',
      permissive: true,
      roles: ['authenticated'],
      using: 'true',
      withCheck: 'owner_id = auth.uid()',
    });
  });
});

describe('DROP POLICY', () => {
  it('DROP POLICY IF EXISTS followed by CREATE POLICY leaves one present policy', () => {
    const result = parse(`
      drop policy if exists "Users can view own todos" on public.todos;
      create policy "Users can view own todos" on public.todos for select using (auth.uid() = user_id);`);
    expect(result.objects).toHaveLength(1);
    expect(objectAt(result, 'policy:public.todos.Users can view own todos')).toMatchObject({
      expect: 'present',
      command: 'SELECT',
    });
  });

  it('on its own expects the policy to be gone', () => {
    const result = parse('drop policy "Old policy" on app.todos;');
    expect(result.objects.map(attributes)).toEqual([
      {
        kind: 'policy',
        expect: 'absent',
        schema: 'app',
        table: 'todos',
        name: 'Old policy',
        command: null,
        permissive: null,
        roles: null,
        using: null,
        withCheck: null,
      },
    ]);
  });
});
