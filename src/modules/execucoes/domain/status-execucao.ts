export enum StatusExecucao {
  NA_FILA = 'NA_FILA',
  EM_DIAGNOSTICO = 'EM_DIAGNOSTICO',
  EM_REPARO = 'EM_REPARO',
  FINALIZADA = 'FINALIZADA',
  FALHOU = 'FALHOU',
  CANCELADA = 'CANCELADA',
}

/** Maquina de estados: para cada status, os destinos permitidos. */
const TRANSICOES: Record<StatusExecucao, StatusExecucao[]> = {
  [StatusExecucao.NA_FILA]: [StatusExecucao.EM_DIAGNOSTICO, StatusExecucao.CANCELADA],
  [StatusExecucao.EM_DIAGNOSTICO]: [
    StatusExecucao.EM_REPARO,
    StatusExecucao.FALHOU,
    StatusExecucao.CANCELADA,
  ],
  [StatusExecucao.EM_REPARO]: [
    StatusExecucao.FINALIZADA,
    StatusExecucao.FALHOU,
    StatusExecucao.CANCELADA,
  ],
  [StatusExecucao.FINALIZADA]: [],
  [StatusExecucao.FALHOU]: [],
  [StatusExecucao.CANCELADA]: [],
};

export function podeTransitar(de: StatusExecucao, para: StatusExecucao): boolean {
  return TRANSICOES[de].includes(para);
}

/** Status que ocupam a fila da oficina. */
export const STATUS_ATIVOS = [
  StatusExecucao.NA_FILA,
  StatusExecucao.EM_DIAGNOSTICO,
  StatusExecucao.EM_REPARO,
] as const;
