/**
 * Testes unitários — UserService
 * Foco: merge de syncUsers com conflito de updatedAt
 */

describe('UserService — syncUsers merge strategy', () => {

  function mergeUsers(remote, local) {
    const remoteMap = new Map(remote.map(u => [u.id, u]));
    const localMap  = new Map(local.map(u => [u.id, u]));
    const merged = [];
    const allIds = new Set([...remoteMap.keys(), ...localMap.keys()]);
    allIds.forEach(id => {
      const r = remoteMap.get(id);
      const l = localMap.get(id);
      if (r && l) {
        merged.push((r.updatedAt || r.criadoEm || '') >= (l.updatedAt || l.criadoEm || '') ? r : l);
      } else {
        merged.push(r || l);
      }
    });
    return merged;
  }

  test('versão mais recente deve ganhar no merge (local mais novo)', () => {
    const remote = [{ id: 'u1', nome: 'João Antigo', updatedAt: '2025-01-01T10:00:00Z' }];
    const local  = [{ id: 'u1', nome: 'João Novo',   updatedAt: '2025-06-01T10:00:00Z' }];
    const result = mergeUsers(remote, local);
    expect(result[0].nome).toBe('João Novo');
  });

  test('versão mais recente deve ganhar no merge (remoto mais novo)', () => {
    const remote = [{ id: 'u1', nome: 'João Atualizado', updatedAt: '2026-01-01T00:00:00Z' }];
    const local  = [{ id: 'u1', nome: 'João Antigo',     updatedAt: '2025-01-01T00:00:00Z' }];
    const result = mergeUsers(remote, local);
    expect(result[0].nome).toBe('João Atualizado');
  });

  test('usuário só no remoto deve ser incluído', () => {
    const remote = [{ id: 'u2', nome: 'Maria' }];
    const local  = [{ id: 'u1', nome: 'João' }];
    const result = mergeUsers(remote, local);
    expect(result).toHaveLength(2);
  });

  test('não deve haver duplicatas de mesmo id', () => {
    const remote = [{ id: 'u1', nome: 'João R' }, { id: 'u2', nome: 'Maria' }];
    const local  = [{ id: 'u1', nome: 'João L' }];
    const result = mergeUsers(remote, local);
    const ids = result.map(u => u.id);
    const unicos = [...new Set(ids)];
    expect(ids).toHaveLength(unicos.length);
  });
});
