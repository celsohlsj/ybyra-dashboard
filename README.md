# YbYrá-BR 🌿

**Plataforma de estimativas de emissões por desmatamento e degradação florestal e remoções pelo crescimento de florestas secundárias no Brasil**

Financiado pelo **CNPq** | Coordenação: Silva-Junior, C. H. L. | UFMA / PPGBC

---

## Sobre o Projeto

O YbYrá-BR produz estimativas anuais, espacialmente explícitas (30m), de:

- **Emissões** por desmatamento de floresta primária
- **Emissões** por degradação florestal — fogo, corte seletivo e efeito de borda
- **Remoções** pelo crescimento de florestas secundárias em regeneração

Cobertura temporal: **1986–2024** | Abrangência: **todos os biomas brasileiros**

O nome deriva do Tupi: *y* (água) + *yrá* (árvore), evocando a interdependência entre floresta e ciclo hidrológico amazônico.

---

## Estrutura do Repositório

```
ybyra-dashboard/
├── index.html                          ← dashboard interativo (auto-contido)
├── README.md
├── gee_export_municipality_biome_v1_2.js  ← script GEE para exportação de tabelas
├── ybyra_consolidate.R                 ← consolidação dos CSVs em R
└── data/                               ← (opcional) CSVs reais gerados pelo pipeline
    └── emissoes_remocoes_dashboard.csv
```

---

## Dashboard

Aplicação estática publicada no GitHub Pages. Funcionalidades:

- Séries temporais de emissões e remoções por território, bioma e categoria
- Balanço líquido (fonte vs. sumidouro)
- Heatmap ano × categoria
- Comparador de territórios
- Ranking de maiores emissores e removedores
- Análise de tendência com interpretação automática
- Gerador de relatórios com gráficos exportáveis (HTML, Markdown)
- Carregamento de CSV externo

### Formato do CSV

```
ano, territorio_tipo, territorio_nome, territorio_codigo,
bioma, estado, regiao, municipio,
categoria, subcategoria, tipo_fluxo,
valor_co2e, unidade, fonte, versao
```

**Categorias de emissão:** Desmatamento · Fogo · Degradação florestal (efeito de borda) · Corte seletivo · Desmatamento de floresta secundária

**Categorias de remoção:** Floresta secundária (regeneração natural)

**Unidade:** MgCO₂e (megagramas = toneladas de CO₂ equivalente)

---

## Pipeline de Dados

### 1. Estimativas no Google Earth Engine

O script `gee_export_municipality_biome_v1_2.js` exporta tabelas CSV da coleção
`emissions_removals_v1_2` agregadas por **município** e por **bioma**:

```
Coleção GEE: projects/ee-redd-brazil/assets/ybyra-br-model/emissions_removals_v1_2
Bandas:  edge_co2 | logging_co2 | fire_co2 | defor_co2 | total_primary_co2
         removal_sf_co2 | defor_sf_co2 | agc_sf_co2 | net_balance_co2
Scale:   500 m (soma regional, erro < 0.5%)
```

### 2. Consolidação em R

O script `ybyra_consolidate.R` lê os CSVs do GEE e gera o arquivo do dashboard:

```r
# Com os CSVs na pasta gee_exports/:
source("ybyra_consolidate.R")
# Saída: dashboard_data/emissoes_remocoes_dashboard.csv
```

Pacotes necessários: `tidyverse`, `fs`

### 3. Carregar no dashboard

Copie o CSV para a pasta `data/` do repositório. O dashboard tenta carregar automaticamente:

```js
fetch('./data/emissoes_remocoes_dashboard.csv')
  .then(r => r.ok ? r.text() : null)
  .then(csv => csv ? loadData(csv) : loadData(DEMO_CSV));
```

---

## Metodologia

### Emissões — floresta primária

| Fonte | Método | Parâmetro-chave |
|---|---|---|
| Desmatamento | AGC × (44/12) × área | AGC inicial: QCN v2 30m |
| Fogo | AGC_pre − AGC_post_fire | AGC_post = 0.07816 × AGC_pre^1.4702 |
| Efeito de borda | AGC × ΔLoss(t) | Michaelis-Menten; α=22.518, β=1.615; EEW=390m |
| Corte seletivo | AGC × p(n) | p(n) = 0.196 × exp(−0.0782 × (n−1)); Tabela 12, FREL Nacional 2024 |

### Remoções — florestas secundárias

Chapman-Richards: `AGC_sf(age) = A × (1 − b × exp(−K × age))^(1/(1−m))`

Parâmetros calibrados por bioma (Robinson et al. 2025, *Nature Climate Change*).
Idades de floresta secundária: Silva-Junior et al. (2020, *Scientific Data*), atualizado MapBiomas C10.1.

### Balanço líquido

`Balanço = Remoções − Emissões`  
Positivo = sumidouro líquido · Negativo = fonte líquida

---

## Referências

- Silva-Junior, C. H. L. et al. (2020). *Scientific Data*. doi:10.1038/s41597-020-00600-4
- Robinson, N. P. et al. (2025). *Nature Climate Change*. doi:10.1038/s41558-025-02355-5
- Aragão, L. E. O. C. et al. (2018). *Nature Communications*. doi:10.1038/s41467-017-02771-y
- Lapola, D. M. et al. (2023). *Science* 379, eabp8622. doi:10.1126/science.abp8622
- Brasil (2024). FREL Nacional Modificado v3. UNFCCC/REDD+.

---

## Citação

```
Silva-Junior, C. H. L. et al. YbYrá-BR v1.2: estimativas de emissões por
desmatamento e degradação florestal e remoções por florestas secundárias
no Brasil (1986–2024). CNPq, 2025. celsohlsj@gmail.com
```

---

*Financiado pelo CNPq. Plataforma desenvolvida para comunicação científica e suporte a MRV, REDD+ e políticas climáticas.*
