# Brasil Carbon Dashboard 🌿

**Plataforma interativa de emissões e remoções de gases de efeito estufa no Brasil**

Desenvolvida pelo IPAM / YbYrá-BR Project | UFMA / PPGBC

---

## Visão Geral

Dashboard estático e completamente auto-contido para exploração, análise e exportação de dados de emissões e remoções de GEE no Brasil, compatível com publicação direta no GitHub Pages.

## Funcionalidades

- **Visualizações**: séries temporais, barras empilhadas, heatmaps, gráficos de contribuição, rankings
- **Filtros dinâmicos**: território, bioma, categoria, ano, tipo de fluxo
- **Análise de tendências**: regressão linear, média móvel, variação percentual com interpretação automática
- **Balanço líquido**: sumidouro vs. fonte, por território e bioma
- **Comparador territorial**: até 3 territórios em paralelo
- **Relatórios automáticos**: exportação em Markdown e HTML
- **Exportação de dados**: CSV filtrado, JSON de configuração
- **Carregamento de CSV externo**: substitua os dados de demonstração pelos seus dados reais

## Estrutura de Arquivos

```
carbon-dashboard/
├── index.html          ← aplicação completa (auto-contida)
├── README.md
└── /data               ← opcional: adicione seus CSVs aqui
    └── emissoes_remocoes_brasil.csv
```

## Estrutura do CSV

```csv
ano,territorio_tipo,territorio_nome,territorio_codigo,bioma,estado,municipio,
categoria,subcategoria,tipo_fluxo,valor_co2e,unidade,fonte,versao
```

### Campos obrigatórios

| Campo | Descrição |
|---|---|
| `ano` | Ano de referência (inteiro) |
| `territorio_nome` | Nome do território (ex: "Pará") |
| `bioma` | Bioma (ex: "Amazônia", "Cerrado") |
| `categoria` | Categoria do fluxo (ex: "Desmatamento") |
| `tipo_fluxo` | `Emissão` ou `Remoção` |
| `valor_co2e` | Valor em tCO₂eq (numérico) |
| `unidade` | Unidade (ex: "tCO2e") |
| `fonte` | Fonte dos dados (ex: "YbYrá-BR") |
| `versao` | Versão do produto (ex: "v1") |

## Publicação no GitHub Pages

1. Crie um repositório no GitHub
2. Faça upload do `index.html` e do `README.md`
3. Vá em **Settings → Pages → Source: Deploy from a branch → main → / (root)**
4. Acesse: `https://<usuario>.github.io/<repositorio>/`

## Dependências (CDN — sem instalação)

- [ECharts 5.4.3](https://echarts.apache.org/) — gráficos interativos
- [PapaParse 5.4.1](https://www.papaparse.com/) — leitura de CSV
- [Google Fonts: DM Sans + DM Mono + Playfair Display](https://fonts.google.com/)

## Categorias suportadas

### Emissões
Desmatamento · Fogo · Degradação florestal · Corte seletivo · Efeito de borda · Agricultura · Pecuária · Solo · Outros

### Remoções
Floresta secundária · Regeneração natural · Restauração ativa · Manguezais · Sistemas agroflorestais · Outros

## Citação

```
YbYrá-BR / IPAM · Brasil Carbon Dashboard v1.0 · 2024
Silva-Junior, C. H. L. et al. · celsohlsj@gmail.com
IPAM / UFMA / PPGBC
```

## Referências

- Silva-Junior et al. (2020). *Scientific Data*.
- Robinson et al. (2025). *Nature Climate Change*.
- Aragão et al. (2018). *Nature Communications*.

---

*Plataforma desenvolvida para comunicação científica e suporte a MRV, REDD+ e políticas climáticas.*
