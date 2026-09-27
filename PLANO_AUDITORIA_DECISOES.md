# Plano completo de auditoria das decisões do Jev

Data: 27/09/2026. Estado: implementação autorizada e integrada no checkout; validação de uma compactação real auditada ainda pendente.
Alvo: `C:\Users\tcfialho\jev-compact`, integrações Codex e Claude Code.

## 1. Decisão recomendada

Implementar uma auditoria local, opt-in, passiva e sem chamadas adicionais à IA. A entrega deve incluir coleta, armazenamento deduplicado, identificação das sessões e chamadas, observação posterior, análise determinística, simulação de regulagens e revisão de casos. São partes de uma única entrega completa, não um MVP seguido de promessas futuras.

O objetivo é responder, com evidências inspecionáveis: a regra foi aplicada corretamente? Que informação foi mantida, encurtada ou removida? O que aconteceu depois? Que evidências justificam mudar uma regulagem?

Não é possível garantir que a observação passiva descubra a melhor decisão em todos os casos. O sistema deve distinguir erro comprovado de execução, sinal posterior, parecer humano e conclusão inconclusiva. A ausência de sinal não será classificada como decisão boa.

Não alterar a política de corte durante esta implementação. Em particular, preservar a regra conservadora atual quando os riscos discordam. Alternativas podem ser simuladas, mas não ativadas automaticamente.

## 2. Escopo e compromissos

- Nenhuma chamada adicional a Jev ou outro modelo; nenhuma solicitação de justificativas.
- Nenhum texto de auditoria adicionado às mensagens, prompts, resultados de ferramentas ou contexto do agente.
- Nenhuma repetição automática de comandos, testes ou tarefas para medir consequências.
- Nenhuma comparação com compactação tradicional nesta entrega.
- Nenhuma conversão de caracteres em tokens ou dinheiro.
- Conteúdo idêntico armazenado uma vez; referências nos demais registros.
- Desligada por padrão e configurável por agente.
- Erros na auditoria não mudam a ação escolhida nem impedem a resposta normal.
- Falhas de captura e lacunas precisam aparecer no diagnóstico local; não podem ser silenciosamente tratadas como ausência de problemas.
- A entrega só será considerada concluída após integração e validação nos fluxos reais de Codex e Claude, além dos testes automatizados.

Uma consulta humana a outra IA sobre o relatório pode consumir tokens. Isso não faz parte da execução automática da auditoria. O relatório deverá permitir exportar apenas os casos escolhidos, com limite de tamanho explícito.

## 3. Evidências atuais e lacunas concretas

Arquivos inspecionados no checkout atual:

| Componente | Evidência | Consequência para o plano |
|---|---|---|
| `src/compact.ts`: `compact`, `questions`, `askBatches`, `apply` | Duas pontuações por candidato; proteção por recência; encurtamento pelo prefixo; tamanho medido com `String.length` | Capturar dados já calculados, sem perguntar novamente; manter a unidade de caracteres compatível com o código |
| `src/store.ts`: `HistoryRow`, `tryAppendHistory` | Histórico com decisões e estatísticas, sem fotografia completa das configurações; falhas de escrita retornam falso | Reaproveitar o histórico e não duplicar suas decisões; acrescentar referência de auditoria e cobertura observável |
| `src/claude-compact.ts`: `compactForClaude` | Registra rejeições por redução mínima; usa `body.sessionId` ou literal `claude`; grava `restored` antes de devolver o corte | Não usar esse status isoladamente como prova de aplicação ou identidade da sessão |
| `hooks/claude.js`: `askJev`, `register` | Envia trigger, provedor, chave e mensagens; não envia sessionId | Obter identidade estável por interface suportada e comprovada antes de correlacionar sessões |
| `src/codex-proxy.ts`: `localCompaction` | Pode retornar antes do registro quando redução é insuficiente ou saída é inválida/grande; grava conclusão antes da entrega HTTP | Registrar todos os motivos de término; distinguir preparação, retorno e consumo observado |
| `src/codex-proxy.ts`: `captureBody` | Captura opt-in do corpo completo de requisições | Não exigir esse mecanismo para auditoria, pois repete histórico e não resolve sozinho a correlação |
| `src/claude.ts`: `applyJevCut` | Adapta cortes de volta às mensagens do Claude | Verificar também esse limite de integração, não apenas o resultado interno do compressor |
| `src/rollout.ts` | Há parser para registros e substituições de histórico do Codex | Reaproveitar onde adequado; não presumir que todos os formatos necessários já sejam suportados |

As contagens anteriormente observadas (2.229 chamadas no Claude, um encurtamento) são observações de um momento e podem incluir reavaliações. Não serão usadas como tamanho de amostra de chamadas independentes.

## 4. Modelo de evidência

Cada avaliação deve acompanhar estados distintos:

1. **Iniciada:** avaliação identificada e configurações fixadas.
2. **Avaliada:** pontuações recebidas e ações propostas calculadas; pode haver falha parcial de lote.
3. **Aceita ou rejeitada:** aplicação do mínimo global e demais condições do adaptador, com motivo específico.
4. **Resultado produzido:** conteúdo de saída construído e referência registrada.
5. **Retorno observado:** adaptador retornou o resultado ou transporte concluiu a escrita. Isso não prova consumo pelo agente.
6. **Aplicação observada:** um evento suportado ou o histórico posterior mostra a substituição correspondente. Se não houver evidência, permanece não confirmada.

Não registrar antecipadamente `aplicada=true`. Para evitar mudança ampla no dashboard existente, esses estados podem complementar os status legados, com significado próprio e explícito na auditoria.

Por item, separar ação da política, ação efetiva observada no resultado produzido e evidência de aplicação no host. Uma compactação rejeitada não conta como remoção aplicada. Falta de confirmação não conta como falha comprovada.

## 5. Identidade e unidades de análise

- `evaluationId`: identificador único criado no início, usado no histórico, nos manifestos e nos eventos posteriores.
- `sessionKey`: agente + identidade nativa da sessão; registrar origem e grau de certeza da associação.
- `callKey`: sessão + identificador nativo da chamada. Colisões ou identificadores ausentes devem ser detectados.
- `occurrenceKey`: ocorrência concreta de execução. Duas execuções iguais não são a mesma chamada.
- `contentHash`: identidade do conteúdo, independente da identidade da execução.
- `observationId`: fonte nativa + posição/evento, para importação idempotente.

Na ausência de ID nativo, usar sessão e posição de ocorrência, com hashes como suporte. Nunca deduplicar execuções só porque ferramenta, argumentos e resultado são iguais.

Apresentar separadamente: avaliações de compactação, decisões por avaliação, chamadas únicas, primeiras avaliações e trajetórias de reavaliação. Não somar a economia do mesmo conteúdo repetidamente como se fossem remoções novas.

No Codex, o texto renderizado para compactação pode não manter IDs estruturados. Não prometer rastreabilidade perfeita através dessa transformação: registrar a relação no momento da renderização e marcar correspondências posteriores ambíguas.

Identidade de sessão e fonte de eventos do Claude são requisitos de implementação a validar no SDK/CLI instalado. Não inventar campo de evento nem unir todas as sessões sob o literal `claude`. Se não houver fonte confiável, informar o bloqueio; a avaliação de consequências desse agente não está entregue.

## 6. Dados a registrar

### Por avaliação

- IDs, agente, horários e sequência local; fonte da sessão e do transcript.
- Versão do esquema, versão do jevcomp e identificação do build/política. Apenas versão npm não distingue alterações locais.
- Modelo/provedor efetivos do Jev, quando disponíveis, sem chaves ou cabeçalhos de autenticação.
- Valores efetivos das configurações: limites de risco e redução, proteção recente, prefixo, limites de estado, lotes e opções que afetam a decisão.
- Referência para a definição exata das perguntas e critérios, guardada uma vez.
- Estado efetivamente enviado ao Jev, incluindo as reduções anteriores à avaliação, etapa de ajuste e associação dos candidatos aos lotes.
- Respostas estruturadas efetivamente recebidas e uso reportado por lote, inclusive cobertura parcial e retries observáveis. Ausência de uso informado é desconhecido, não zero.
- Tamanhos internos antes/depois e tamanho da saída efetiva do adaptador, em campos separados.
- Motivos de aceitação, rejeição e falha; progresso de aplicação e cobertura da captura.

### Por chamada

- Identidades, ferramenta, referências dos argumentos e resultados originais; indicadores de erro.
- Pontuações originais recebidas; para protegidas, indicação de não avaliada, sem apresentar o valor interno de fallback como pontuação do Jev.
- Proteção por recência e posição/idade na conversa quando derivável.
- Ação proposta, ação efetiva no resultado, motivo da regra, inclusive encurtamento sem economia.
- Tamanhos, referência do prefixo preservado e da saída produzida, ligados ao conteúdo original.

As decisões e estatísticas que já existem no histórico não serão copiadas integralmente para outro log. O registro canônico será ligado por `evaluationId`; eventos de progresso referenciarão esse registro. Dados comuns, como configurações e perguntas, serão objetos compartilhados por hash. O armazenamento precisa preservar essa referência mesmo após retenção, ou declarar a evidência indisponível.

### Conteúdo necessário

Recomendo dois modos finais, ambos opt-in:

- **Metadados:** regras, pontuações, tamanhos e hashes. Permite auditar a execução e distribuições; não promete revisão semântica completa.
- **Evidências:** inclui conteúdo necessário para reconstruir entrada, estado do Jev e saída, deduplicado. É o modo recomendado para responder à pergunta de qualidade do usuário.

Não recomendo capturar apenas anomalias como único modo de evidências. Isso exclui casos aparentemente normais e pode perder o original antes que uma consequência apareça.

Não guardar envelopes com API keys, variáveis de ambiente completas ou cabeçalhos. Conteúdo de ferramentas pode conter dados sensíveis; hashes e nomes também não equivalem a anonimização. Transformações de conteúdo devem ser declaradas: conteúdo sanitizado não será chamado de reprodução byte a byte.

## 7. Armazenamento, concorrência e custo local

Raiz proposta: `C:\Users\tcfialho\.jevcomp\audit`, respeitando o diretório de dados configurado. Layout lógico: manifestos por avaliação, objetos comprimidos por hash, índices derivados reconstruíveis e pareceres de revisão separados.

- Identidade do objeto calculada sobre bytes com formato e versão definidos. Hash de igualdade exata separado de normalizações usadas só para procurar correspondências.
- Objetos compartilhados para textos, argumentos, perguntas e mensagens. Manifestos contêm listas ordenadas de referências; não concatenar e copiar toda a conversa a cada avaliação.
- Gravação atômica, arquivos temporários no armazenamento de auditoria e publicação após conclusão. Escritores concorrentes não podem sobrescrever objetos parcialmente.
- Fila de trabalho limitada por bytes, não apenas quantidade de itens. Reutilizar dados em memória; não iniciar processo por chamada ou requisição.
- Um registro pequeno de conclusão será aguardado no ponto apropriado, com tratamento de erro. Não prometer gravação durável sem nenhum tempo adicional.
- Captura pesada tem orçamento limitado; ao excedê-lo, registrar cobertura parcial, quando possível, e continuar o fluxo. No processo curto do Claude, não depender de promessa abandonada depois do retorno.
- Se disco cheio impedir até o registro do erro, o diagnóstico local deve detectar inconsistências; ausência completa de evento não pode ser contada como sucesso de captura.
- Não rodar correlação, varredura de transcripts ou coleta de lixo durante a decisão de cada chamada.

Defaults propostos para discussão: 500 MiB de auditoria e 30 dias de retenção. São limites operacionais, não resultados de benchmark. Reservar margem para metadados; ao atingir a cota sem espaço elegível para liberar, suspender conteúdo novo e informar a lacuna.

Retenção remove unidades de evidência de sessões encerradas, das mais antigas, e só apaga objetos sem referências restantes. Sessões ativas maiores que a cota ficam com captura parcial explicitamente registrada. A limpeza pode acontecer pelo comando local de manutenção/análise, fora da compactação; a cota de escrita não depende de essa limpeza ter ocorrido. Concorrência entre escrita e limpeza exige proteção e período de segurança para objetos ainda em publicação.

Índices e resultados de análise podem ser reconstruídos; evidência original e pareceres não. Desligar coleta não apaga conteúdo. Exclusão de conteúdo será ação explícita ou retenção previamente configurada.

## 8. Observação do que aconteceu depois

O analisador será executado sob demanda e lerá os transcripts já gravados pelos agentes. Nada será enviado à IA para interpretar comportamento.

Adaptadores devem validar formato, identidade, sequência e fronteiras de compactação. Guardar posição, identidade da fonte e hash de trecho para detectar rotação ou substituição. Um arquivo que sumiu gera evidência indisponível. Não copiar o transcript inteiro; materializar no armazenamento apenas trechos necessários para casos revisados, com deduplicação.

Uma sessão poderá ter observação completa, parcial, fonte indisponível ou associação ambígua. Não excluir silenciosamente sessões curtas. Informar número de eventos/turnos observados e motivos conhecidos de encerramento. Usar pedidos ao modelo apenas onde a fonte permite identificá-los; em outros casos, denominar a unidade realmente observável.

Relatar janelas de 5, 10 e 20 eventos de continuação suportados, além do segmento até a próxima compactação, sempre com exposição e cobertura. Esses valores são convenções de relatório e não fronteiras de dano. Não tratar grupos com tempos de observação diferentes como equivalentes.

Classificações possíveis de evidência posterior:

1. Resultado idêntico reapareceu: igualdade exata de conteúdo.
2. Trecho omitido reapareceu: sobreposição substantiva no trecho além do prefixo, excluindo marcadores e texto genérico.
3. Mesma operação com conteúdo diferente: igualdade de operação não implica mesma informação.
4. Operação semelhante: pista para revisão, sem afirmar recuperação.
5. Nenhum sinal encontrado no intervalo observado.

Uma nova leitura pode usar outra ferramenta ou outros argumentos. Índices de trechos e normalizações específicas da ferramenta ajudam a encontrar candidatos, mas a evidência apresentada deve manter os bytes originais. Não remover partes arbitrárias de comandos ou argumentos para forçar igualdade.

Não afirmar que um arquivo não mudou apenas porque não vimos uma ferramenta de escrita: processos externos e comandos shell também podem alterá-lo. Igualdade de resultados comprova igualdade dos resultados observados, não ausência de todas as mudanças intermediárias.

Falha de teste, nova leitura ou correção explícita pode ser anexada ao caso como evento. Não inferir frustração, sucesso global da tarefa ou causalidade por palavras-chave. Comentários do usuário sobre perda de contexto podem ser anotados manualmente, com referência ao evento.

## 9. Métricas e o que elas permitem concluir

| Pergunta | Medida e denominador | Interpretação permitida |
|---|---|---|
| A auditoria capturou o necessário? | Avaliações completas/parciais, fontes disponíveis, eventos pendentes e falhas detectadas | Cobertura observável; não prometer capturar avaliações que nem chegaram a ser registradas |
| A regra foi obedecida? | Divergências por decisão reconstruível; excluídas explicitamente as sem dados suficientes | Erro de execução ou esquema incompatível a investigar |
| Por que encurtou pouco? | Funil: não protegidas → elegíveis por tamanho → par de riscos favorável → economia positiva → compactação aceita → aplicação observada | Localiza o filtro que eliminou candidatos; não revela raciocínio interno |
| Como os riscos se distribuem? | Distribuição conjunta, distância ao limite e casos `truncateLoss > dropLoss`, por ferramenta/modelo/configuração | Descrição das estimativas; não prova calibração ou defeito |
| Quanto foi proposto e efetivado? | Tamanho antes/depois, corte rejeitado/aceito/observado, por avaliação | Redução de caracteres nos objetos medidos; não economia financeira |
| Omitidos reapareceram? | Ocorrências e tempo até reaparecimento, por chamada com corte observado e cobertura posterior suficiente; incompletas separadas | Sinal de possível recuperação, sem atribuir causa |
| Mantidos foram citados? | Correspondências explícitas por chamada mantida; exposição e ausência de correspondência separadas | Uso textual detectado, não utilidade total ou desperdício comprovado |
| Decisões mudaram? | Trajetórias por chamada, separando mudança de conteúdo/contexto/configuração/modelo | Mudança observada; só conteúdo/contexto equivalentes permitem investigar instabilidade |
| Qual foi o custo Jev? | Uso reportado por avaliação/lote, separando aceitas, rejeitadas, falhas e cobertura desconhecida | Consumo informado, sem chamar toda rejeição de desperdício |

Distribuições devem oferecer visão de primeira avaliação e de todas as avaliações; não tratar reavaliações da mesma sessão como amostras independentes. Revisões de amostra dirigida não estimam a taxa global de erro.

Não criar nota única de qualidade. Não usar o produto caracteres × turnos como economia real. Não calcular tokens por aproximação de quatro caracteres. Custo futuro evitado exige uma alternativa não observada; permanecerá fora das conclusões desta auditoria.

## 10. Simulação local de regulagens

Executar a política determinística sobre avaliações registradas, sem consultar Jev e sem alterar dados originais.

Simular limiar comum ou limiares separados como políticas nomeadas. Recalcular proteção, economia real do encurtamento com marcador, ações por chamada, tamanho global proposto, mínimo de redução e condições determinísticas conhecidas do adaptador. Distinguir eliminação de mensagens vazias de economia atribuível aos resultados das ferramentas.

Saída: quais chamadas mudariam, tamanho resultante e quais avaliações passariam ou falhariam nas condições locais. Não prever releituras, erros ou sucesso sob a política alternativa.

Limitações obrigatórias:

- Pontuações de prefixo de 300 caracteres não avaliam um prefixo de 1.000, nem uma seleção de começo e fim. Não reutilizá-las como se avaliassem essas ações.
- Chamadas protegidas sem pontuação não podem ser simuladas como avaliadas se a proteção for reduzida.
- Mudar contexto, perguntas ou modelo invalida a equivalência das pontuações antigas.
- A simulação é local a cada fotografia observada. Mudar uma compactação alteraria entradas posteriores; não compor fotografias reais como uma sessão alternativa comprovada.
- Comparação perto do limite é exploratória; não há garantia automática de causalidade.

## 11. Revisão de casos e decisão sobre mudanças

Gerar uma amostra reprodutível com seed, regras de seleção e inclusão conhecidas. Incluir encurtados, reaparecimentos de conteúdo, divergência de riscos, decisões próximas do limite, mantidos volumosos e uma parcela aleatória dos demais casos. Não limitar a revisão às anomalias.

Proposta de interface: até 30 casos por relatório, configurável, com cotas adaptadas à disponibilidade. É orçamento de leitura, não tamanho de amostra estatisticamente suficiente. Exibir quantos ficaram fora e evitar repetições desnecessárias da mesma chamada.

Cada caso mostra, sob demanda:

- decisão, configuração, riscos e regra que a produziu;
- entrada relevante, contexto apresentado ao Jev e resultado efetivo, com referências;
- sequência posterior e conteúdo reaparecido, se houver;
- cobertura, lacunas e motivos para seleção;
- evidência de que a informação existia em outro local, quando identificável.

Roteiro de parecer: aplicação correta? Informação necessária naquele momento ou somente depois? Estava disponível em outro lugar? Recuperação era viável e aceitável? O prefixo realmente bastaria? Há dano observado ou apenas hipótese? Faltam dados?

Salvar parecer, autor, data, referências e confiança declarada. Parecer pode ser revisado e não substitui evidência. Não classificar como erro de risco só porque a informação foi relida.

Uma mudança de regulagem exige: problema recorrente bem documentado, explicação das limitações, simulação do alcance e critério explícito de acompanhamento posterior. Não exigir ganho arbitrário de 15% nem prometer releituras menores que 2%. A mudança continua sendo decisão separada do usuário.

## 12. Interface proposta

Nomes abaixo são propostas, não comandos existentes:

- `jevcomp audit enable <codex|claude> --mode <metadata|evidence>`: ativação explícita e resumo de retenção/conteúdo.
- `jevcomp audit disable <codex|claude>`: interrompe coleta futura.
- `jevcomp audit status`: fontes suportadas, configuração, consumo de disco, cobertura e falhas.
- `jevcomp audit report`: relatório local compacto, sem conteúdo bruto por padrão.
- `jevcomp audit inspect <case-id>`: evidências selecionadas de um caso.
- `jevcomp audit simulate`: comparação determinística de políticas sobre avaliações registradas.
- `jevcomp audit review <case-id>`: parecer humano persistido.
- `jevcomp audit prune`: aplicar retenção configurada e limpar objetos sem referências, com resumo do que foi removido.

Relatório padrão com limite proposto de 16 KiB, totais, funil de encurtamento, cobertura e referências para detalhes. Corte de exibição deve ser explícito e não cortar silenciosamente a análise. Exportar texto/JSON sob demanda, sem enviar a serviço externo. Não adicionar painel novo nem redesenhar dashboard nesta entrega; a CLI é a superfície completa de auditoria.

## 13. Integração técnica prevista

| Arquivos atuais | Mudança necessária |
|---|---|
| `src/compact.ts` | Ponto de observação opcional dos estados, lotes, respostas e ações; manter comportamento e requisições idênticos |
| `src/provider.ts` | Somente se necessário para contabilizar tentativas/uso já recebidos sem repetir chamadas; excluir autenticação |
| `src/store.ts` | IDs/referências canônicas e cobertura, preservando leitura dos registros antigos |
| `src/claude-compact.ts`, `hooks/claude.js`, `src/claude.ts` | Sessão confiável, resultado proposto/retornado e integração com evidência de aplicação |
| `src/codex-proxy.ts` | Rejeições e falhas registradas; associação da saída renderizada e término de transporte |
| `src/rollout.ts` e adaptador Claude a criar | Leitura incremental das fontes nativas, correlação de eventos e lacunas explícitas |
| `src/cli.ts` | Comandos locais, configuração opt-in e relatórios |
| Novos módulos de auditoria | Armazenamento, esquema, análise, simulação e revisão, separados da política de compactação |
| `tests` e `dist` | Regressões significativas, build oficial e artefatos integrados |

Evitar nova dependência pesada e serviço residente. Índice derivado local, leitura incremental e primitivas existentes de Node são a preferência; escolher mecanismo de índice depois de medir o volume representativo, sem transformar isso numa reestruturação do produto.

## 14. Checklist de execução da entrega completa

Dependências abaixo são ordem técnica de trabalho, não entregas parciais oferecidas como conclusão.

- [ ] Validar interfaces instaladas de sessão/transcript dos dois agentes e documentar a origem real de cada associação.
- [ ] Definir esquema versionado, unidades, estados de aplicação e compatibilidade com histórico legado.
- [ ] Integrar registro canônico de todas as avaliações, inclusive rejeições e falhas parciais.
- [ ] Implementar captura opt-in, objetos compartilhados, cotas, concorrência e diagnóstico de perda de evidência.
- [ ] Integrar adaptadores nativos de observação posterior e correlação sem execução de ferramentas.
- [ ] Implementar métricas, funil, simulações, amostragem e limites de relatório.
- [ ] Implementar inspeção e persistência de pareceres humanos.
- [ ] Validar neutralidade de chamadas/payloads, correção, falhas, desempenho e retenção.
- [ ] Compilar os artefatos oficiais e validar sessões reais de Codex e Claude, com relatório gerado a partir delas.
- [ ] Conferir diff, branch, arquivos gerados e estado final do Git; relatar qualquer bloqueio sem declarar entrega completa.

## 15. Validação e critérios de aceitação

### Neutralidade em relação à IA

Com as mesmas entradas e respostas fixadas, comparar auditoria desligada/ligada: mesmos corpos enviados ao Jev e ao agente, mesma quantidade de chamadas e retries, mesmas decisões e saídas. Testar sucesso, rejeição, falha de provedor e falha de disco. Não basta contar requests; comparar conteúdo para detectar instruções ou metadados indevidos.

### Correção da análise

Casos com: pontuações nos limites, riscos discordantes, prefixo sem economia, chamadas protegidas, múltiplos resultados, compactação abaixo do mínimo, saída inválida, reavaliações, IDs ausentes, sessões simultâneas, transcripts truncados/rotacionados e conteúdo repetido por operações diferentes.

As simulações devem reproduzir a política original quando configuradas com os valores originais. Verificação independente das fórmulas em fixtures, para não testar apenas uma função contra ela mesma. Cobertura desconhecida deve aparecer como desconhecida.

### Desempenho e recursos

Medir auditoria desligada, metadados e evidências: p50/p95/máximo de latência adicional, CPU, pico de memória, bytes gravados e taxa de deduplicação, com volumes declarados e disco normal/lento. Medir também análise incremental e limpeza concorrente.

Não prometer antecipadamente 10 ms ou um segundo para qualquer volume. Não há custo computacional zero: hashing, compressão e escrita devem ser medidos. Orçamentos devem limitar trabalho e informar captura parcial; a validação deve mostrar os valores para decidir se a sobrecarga é aceitável, antes de declarar a entrega aprovada.

### Fluxo real

No Codex e no Claude: ativar explicitamente, capturar uma compactação real autorizada, confirmar a identidade da sessão e o estado de aplicação observável, ler os eventos seguintes já produzidos, gerar relatório e abrir um caso. Nenhuma sessão alternativa será executada automaticamente para obter contrafactual. Se a validação exigir uma chamada de IA exclusivamente de teste, isso precisa ser autorizado separadamente ou aguardar uma execução normal.

### Sucesso do produto

O usuário consegue seguir uma decisão desde os dados avaliados até as consequências observadas, verificar a regra, inspecionar o conteúdo relevante e ver exatamente o que uma regulagem diferente mudaria na fotografia original. O relatório pode concluir que não há evidência suficiente para mudar nada; isso não é falha da auditoria.

## 16. Exemplo de interpretação correta

Uma leitura foi removida com riscos 0,31 e 0,28; depois, o mesmo conteúdo reapareceu em outra leitura.

Conclusões válidas: a política mandava remover; a remoção foi observada ou não confirmada; houve reaparecimento idêntico após determinado intervalo; a revisão aponta uma linha necessária e sua posição fora do prefixo.

Conclusões não autorizadas automaticamente: a remoção causou a releitura; o risco estava errado; manter teria sido mais barato; a tarefa sofreu dano; houve economia líquida de determinado número de tokens.

O parecer pode recomendar investigar o tratamento de leituras recuperáveis ou a preservação do trecho relevante. Uma simulação mostra alcance da política alternativa, sem inventar seu resultado posterior.

## 17. Decisão solicitada e estado deste documento

Recomendação: aprovar a solução completa acima, com coleta desligada por padrão e modo evidências recomendado quando a pergunta for qualidade. Aprovar implementação não implica ativar coleta pessoal nem alterar regulagens de corte automaticamente.

Bloqueios técnicos a resolver durante a implementação: identidade/fonte nativa confiável do Claude, confirmação observável de aplicação em ambos os hosts e lifecycle de gravação no processo curto. Não estão declarados resolvidos neste plano.

Registro de execução: `src/audit-store.ts`, `src/audit.ts`, `src/audit-sources.ts`, `src/audit-analysis.ts` e `src/audit-cli.ts` implementam a coleta e a análise. Os adaptadores e a CLI foram integrados; `dist` é gerado pelo build. Os testes com transporte Jev local e adaptadores do produto validam a neutralidade das requisições, rejeições, objetos compartilhados, correlação, simulação, revisão e retenção. O pacote npm contém os novos módulos.

Limite concreto observado: o checkpoint nativo do Codex pode conter `encrypted_content`. Nesse caso, a auditoria registra a fronteira e a entrega HTTP, mas não declara comprovado o conteúdo que o agente consumiu. O Claude possui `$.session.id()` e `session_id`/`transcript_path` no hook instalado; a correlação de aplicação depende de uma entrada posterior observável. Nenhuma coleta pessoal foi ativada, e nenhuma chamada de IA foi feita apenas para validação. Uma compactação real auditada nos dois hosts permanece pendente até ocorrer numa sessão com coleta opt-in.
