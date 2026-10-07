import { analyzeAudit, auditReport } from './audit-analysis.js';
import { COST_WEIGHTS, experimentProgress, type ExperimentAgent } from './experiment.js';
import { userSettings } from './settings.js';

type Env = Record<string, string | undefined>;

const AGENT_NAME: Record<ExperimentAgent, string> = { codex: 'Codex', claude: 'Claude Code', agy: 'Antigravity' };
const MAX_CHARS = 60_000;

/** Text the user pastes into another AI: the measured verdict plus the cases where cut content came back. */
export async function experimentPackage(env: Env, agent: ExperimentAgent): Promise<string> {
  const progress = await experimentProgress(env, agent);
  const result = progress.lastResult;
  if (!result) throw new Error('no finished measurement for this agent yet');
  let cases: unknown;
  try {
    const analysis = await analyzeAudit(env);
    analysis.cases = analysis.cases.filter((item) => item.agent === agent);
    cases = auditReport(analysis, 'jev-audit-v1', 30);
  } catch (error) {
    cases = { unavailable: error instanceof Error ? error.message : String(error) };
  }
  const data = {
    agent: AGENT_NAME[agent],
    measuredResult: result,
    costWeights: COST_WEIGHTS,
    settings: userSettings(env, agent),
    decisionCases: cases,
  };
  let json = JSON.stringify(data, null, 1);
  if (json.length > MAX_CHARS) json = JSON.stringify({ ...data, decisionCases: { omitted: `too large (${json.length} characters)` } }, null, 1);
  const unit = agent === 'agy' ? 'sessão' : 'compactação';
  return [
    `Você vai analisar uma medição do jevcomp no ${AGENT_NAME[agent]}. O jevcomp usa um modelo pequeno (Jev) para decidir quais saídas antigas de comandos manter, encurtar ou remover do contexto do agente.`,
    '',
    `Como a medição foi feita: cada ${unit} foi sorteada entre "jev" (o jevcomp decide o corte) e "native" (o próprio agente compacta, sem o Jev). Para cada uma, somamos os tokens cobrados pelo modelo do agente na compactação e nas requisições seguintes, com os pesos de preço em costWeights (entrada sem cache = 1). measuredResult traz as médias por grupo, a economia (savingRatio = 1 - jev/native) e o intervalo de 95%. O custo do próprio Jev está em jevTokens e NÃO entra na economia.`,
    '',
    'decisionCases traz decisões do Jev auditadas, incluindo casos em que conteúdo cortado reapareceu depois (sinal de que fez falta).',
    '',
    'Responda em português, de forma direta:',
    '1. O veredito (ganho, perda ou sem diferença) se sustenta com esses números? Considere também o custo do Jev.',
    '2. Nos casos em que o corte fez falta, qual o padrão (tipo de comando, idade da mensagem, tamanho)?',
    '3. Que mudanças concretas nas configurações (settings) ou nas regras de corte você recomenda, e qual o efeito esperado de cada uma?',
    '4. Que dado faltou para uma conclusão mais firme?',
    '',
    'Dados:',
    '```json',
    json,
    '```',
  ].join('\n');
}
