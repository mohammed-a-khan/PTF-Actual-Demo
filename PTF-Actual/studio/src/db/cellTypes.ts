/** Result cells as JSON (shared by the server and the browser: no Node types here). */
export type Cell = null | number | boolean | string
    | { $t: 'date'; v: string }
    | { $t: 'big'; v: string }
    | { $t: 'bin'; v: string; n: number }
    | { $t: 'json'; v: string }
    | { $t: 'text'; v: string; n: number };

export interface Column { name: string; type: string }
