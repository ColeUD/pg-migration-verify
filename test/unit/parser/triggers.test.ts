/** CREATE TRIGGER: timing and event bitmasks decoded, events in a fixed order. */
import { beforeAll, describe, expect, it } from 'vitest';
import type { TriggerObject } from '../../../src/model.js';
import { loadParser } from '../../../src/parser/index.js';
import { attributes, parse } from './helpers.js';

beforeAll(loadParser);

type TriggerAttributes = Omit<TriggerObject, 'key' | 'source' | 'kind' | 'expect'>;

describe('CREATE TRIGGER', () => {
  it.each<[string, string, TriggerAttributes]>([
    [
      'Supabase auth hook: AFTER INSERT, EXECUTE PROCEDURE, other schema',
      'create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();',
      {
        schema: 'auth',
        table: 'users',
        name: 'on_auth_user_created',
        timing: 'AFTER',
        events: ['INSERT'],
        forEachRow: true,
        function: { schema: 'public', name: 'handle_new_user' },
      },
    ],
    [
      'BEFORE INSERT OR UPDATE OF columns',
      'create trigger set_updated_at before insert or update of title, status on todos for each row execute function set_updated_at();',
      {
        schema: 'public',
        table: 'todos',
        name: 'set_updated_at',
        timing: 'BEFORE',
        events: ['INSERT', 'UPDATE'],
        forEachRow: true,
        function: { schema: null, name: 'set_updated_at' },
      },
    ],
    [
      'FOR EACH STATEMENT, events reported in INSERT/UPDATE/DELETE/TRUNCATE order',
      'create trigger audit after truncate or delete or update on app.todos execute function audit.log_change();',
      {
        schema: 'app',
        table: 'todos',
        name: 'audit',
        timing: 'AFTER',
        events: ['UPDATE', 'DELETE', 'TRUNCATE'],
        forEachRow: false,
        function: { schema: 'audit', name: 'log_change' },
      },
    ],
    [
      'INSTEAD OF on a view',
      'create trigger open_todos_update instead of update on open_todos for each row execute function update_open_todo();',
      {
        schema: 'public',
        table: 'open_todos',
        name: 'open_todos_update',
        timing: 'INSTEAD OF',
        events: ['UPDATE'],
        forEachRow: true,
        function: { schema: null, name: 'update_open_todo' },
      },
    ],
    [
      'CONSTRAINT trigger, deferrable',
      'create constraint trigger check_owner after insert or delete on todos deferrable initially deferred for each row execute function check_owner();',
      {
        schema: 'public',
        table: 'todos',
        name: 'check_owner',
        timing: 'AFTER',
        events: ['INSERT', 'DELETE'],
        forEachRow: true,
        function: { schema: null, name: 'check_owner' },
      },
    ],
    [
      'CREATE OR REPLACE with WHEN, quoted names',
      'create or replace trigger "Audit Trigger" before delete on "Orders" for each row when (old.locked) execute function "Guard"();',
      {
        schema: 'public',
        table: 'Orders',
        name: 'Audit Trigger',
        timing: 'BEFORE',
        events: ['DELETE'],
        forEachRow: true,
        function: { schema: null, name: 'Guard' },
      },
    ],
  ])('%s', (_label, sql, expected) => {
    const result = parse(sql);
    expect(result.notes).toEqual([]);
    expect(result.objects.map(attributes)).toEqual([
      { kind: 'trigger', expect: 'present', ...expected },
    ]);
  });

  it('keys triggers by table, since trigger names are only unique per table', () => {
    const result = parse(`
      create trigger touch before update on todos for each row execute function touch();
      create trigger touch before update on projects for each row execute function touch();`);
    expect(result.objects.map((o) => o.key)).toEqual([
      'trigger:public.todos.touch',
      'trigger:public.projects.touch',
    ]);
  });
});
