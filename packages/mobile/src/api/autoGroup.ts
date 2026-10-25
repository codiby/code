import type { TabGroup } from './preferences';
import type { SessionSummary } from './types';

/**
 * Un worktree vive en `<repo>/.worktrees/<rama>` (o `.wt`), así que su carpeta
 * es el nombre de la rama y no el del proyecto.
 *
 * Es la misma expresión que `WORKTREE_CWD_RE` en
 * `packages/core/handlers/worktree.ts` del bridge: si allá cambia, aquí
 * también, o una rama acabaría en un grupo con nombre de rama en vez de caer
 * en el de su repositorio.
 */
const WORKTREE_RE = /^(.*?)[\\/]\.(?:worktrees|wt)[\\/][^\\/]+$/;

function basename(path: string): string {
  const segments = path.split('/').filter(segment => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

/** La carpeta que da nombre al grupo: el repositorio, no el worktree. */
export function projectOf(cwd: string): string {
  const match = WORKTREE_RE.exec(cwd);
  return basename(match?.[1] ?? cwd);
}

export interface GroupPlan {
  /** Nombre del grupo, tal cual se creará o se buscará. */
  readonly name: string;
  /** Ya existía en alguna máquina: se reutiliza en vez de crear otro. */
  readonly exists: boolean;
  readonly sessions: SessionSummary[];
}

export interface AutoGroupPlan {
  readonly groups: GroupPlan[];
  /** Cuántas sesiones se moverían en total. */
  readonly moved: number;
}

/**
 * Qué haría «Auto agrupar» sobre las sesiones sin grupo.
 *
 * Se calcula aparte de aplicarlo para poder enseñarlo antes: esto escribe en
 * las preferencias de varias máquinas y no hay deshacer.
 *
 * Una regla: toda suelta acaba en el grupo de su proyecto, creándolo si no
 * existe. Nunca toca una sesión que ya tiene grupo — eso lo pusiste tú.
 *
 * Provisional: la misma regla se está montando en el bridge para no tenerla
 * escrita dos veces. Cuando `GET/POST /sessions/auto-group` estén desplegados
 * en las dos máquinas, esto se tira y la app pasa a ser un cliente.
 */
export function planAutoGroup(
  sessions: SessionSummary[],
  groupBySession: Record<string, string>,
  groups: TabGroup[],
): AutoGroupPlan {
  const existing = new Set(groups.map(group => group.name.trim().toLowerCase()));

  const byProject = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (groupBySession[session.key] !== undefined) {
      continue;
    }
    const name = projectOf(session.cwd);
    if (name.length === 0) {
      continue;
    }
    const bucket = byProject.get(name);
    if (bucket === undefined) {
      byProject.set(name, [session]);
    } else {
      bucket.push(session);
    }
  }

  const plan: GroupPlan[] = [];
  let moved = 0;

  for (const [name, items] of byProject) {
    plan.push({ name, exists: existing.has(name.toLowerCase()), sessions: items });
    moved += items.length;
  }

  // Los grupos con más sesiones primero: es el orden en que se leen mejor en
  // el resumen de confirmación.
  plan.sort((a, b) => b.sessions.length - a.sessions.length);
  return { groups: plan, moved };
}
