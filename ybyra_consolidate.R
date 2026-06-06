# =============================================================================
# YbYrá-BR | Consolidação GEE → Dashboard
# ybyra_consolidate.R
#
# Lê os CSVs exportados pelo GEE (por município e por bioma),
# converte para o formato longo do Brasil Carbon Dashboard e
# gera arquivos CSV por recorte territorial.
#
# Estrutura de entrada (pasta gee_exports/):
#   ybyra_emiss_mun_1986.csv … ybyra_emiss_mun_2024.csv
#   ybyra_emiss_biome_1986.csv … ybyra_emiss_biome_2024.csv
#
# Estrutura de saída (pasta dashboard_data/):
#   emissoes_remocoes_municipio.csv
#   emissoes_remocoes_estado.csv
#   emissoes_remocoes_regiao.csv
#   emissoes_remocoes_bioma.csv
#   emissoes_remocoes_brasil.csv
#   emissoes_remocoes_dashboard.csv  ← todos os recortes juntos
#
# Formato de saída (dashboard):
#   ano, territorio_tipo, territorio_nome, territorio_codigo,
#   bioma, estado, regiao, municipio,
#   categoria, subcategoria, tipo_fluxo,
#   valor_co2e, unidade, fonte, versao
#
# Autores: YbYrá-BR
# Versão: 1.2 — 2025
# =============================================================================

library(tidyverse)   # readr, dplyr, tidyr, purrr, stringr
library(fs)          # dir_ls, dir_create

# ─────────────────────────────────────────────────────────────────────────────
# 0. CONFIGURAÇÃO
# ─────────────────────────────────────────────────────────────────────────────
INPUT_MUN   <- "gee_exports"          # pasta com CSVs do GEE
OUTPUT_DIR  <- "dashboard_data"       # pasta de saída
FONTE       <- "YbYrá-BR"
VERSAO      <- "v1.2"
UNIDADE     <- "MgCO2e"

dir_create(OUTPUT_DIR)

# ─────────────────────────────────────────────────────────────────────────────
# 1. MAPEAMENTO: banda GEE → variáveis do dashboard
# ─────────────────────────────────────────────────────────────────────────────
# Cada entrada: c(categoria, subcategoria, tipo_fluxo)
BAND_MAP <- list(
  defor_co2      = c("Desmatamento",       "Floresta primária",      "Emissão"),
  logging_co2    = c("Corte seletivo",     "Exploração madeireira",  "Emissão"),
  fire_co2       = c("Fogo",              "Degradação por fogo",    "Emissão"),
  edge_co2       = c("Degradação florestal","Efeito de borda",       "Emissão"),
  defor_sf_co2   = c("Desmatamento",       "Floresta secundária",    "Emissão"),
  removal_sf_co2 = c("Floresta secundária","Regeneração natural",    "Remoção")
)

# ─────────────────────────────────────────────────────────────────────────────
# 2. NORMALIZAÇÃO DE CAMPOS (GAUL vs IBGE)
# ─────────────────────────────────────────────────────────────────────────────
# O GEE pode exportar com campos IBGE (CD_MUN, NM_MUN, NM_UF, SIGLA_UF)
# ou com campos FAO GAUL (ADM2_CODE, ADM2_NAME, ADM1_NAME).
# Esta função detecta e normaliza automaticamente.
normalize_mun_fields <- function(df) {
  if ("ADM2_NAME" %in% names(df) && !"NM_MUN" %in% names(df)) {
    message("  [INFO] Formato GAUL detectado — normalizando campos...")
    
    # Renomeia colunas GAUL → padrão IBGE
    rename_map <- c(NM_MUN = "ADM2_NAME", NM_UF = "ADM1_NAME")
    if ("ADM2_CODE"      %in% names(df)) rename_map <- c(rename_map, CD_MUN = "ADM2_CODE")
    if ("ADM2_CODE_2015" %in% names(df)) rename_map <- c(rename_map, CD_MUN = "ADM2_CODE_2015")
    df <- df |> rename(any_of(rename_map))
    
    # Tabela nome do estado → sigla
    sigla_tab <- c(
      "Acre"="AC","Alagoas"="AL","Amapá"="AP","Amazonas"="AM","Bahia"="BA",
      "Ceará"="CE","Distrito Federal"="DF","Espírito Santo"="ES","Goiás"="GO",
      "Maranhão"="MA","Mato Grosso"="MT","Mato Grosso do Sul"="MS",
      "Minas Gerais"="MG","Pará"="PA","Paraíba"="PB","Paraná"="PR",
      "Pernambuco"="PE","Piauí"="PI","Rio de Janeiro"="RJ",
      "Rio Grande do Norte"="RN","Rio Grande do Sul"="RS","Rondônia"="RO",
      "Roraima"="RR","Santa Catarina"="SC","São Paulo"="SP",
      "Sergipe"="SE","Tocantins"="TO"
    )
    df <- df |> mutate(
      CD_MUN   = as.character(CD_MUN),
      SIGLA_UF = sigla_tab[NM_UF]
    )
  } else {
    df <- df |> mutate(CD_MUN = as.character(CD_MUN))
  }
  
  # Garante NM_REGIAO
  if (!"NM_REGIAO" %in% names(df) || all(is.na(df$NM_REGIAO))) {
    regiao_tab <- c(
      AC="Norte",AP="Norte",AM="Norte",PA="Norte",RO="Norte",RR="Norte",TO="Norte",
      AL="Nordeste",BA="Nordeste",CE="Nordeste",MA="Nordeste",PB="Nordeste",
      PE="Nordeste",PI="Nordeste",RN="Nordeste",SE="Nordeste",
      DF="Centro-Oeste",GO="Centro-Oeste",MT="Centro-Oeste",MS="Centro-Oeste",
      ES="Sudeste",MG="Sudeste",RJ="Sudeste",SP="Sudeste",
      PR="Sul",RS="Sul",SC="Sul"
    )
    df <- df |> mutate(NM_REGIAO = regiao_tab[SIGLA_UF])
  }
  df
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. FUNÇÕES DE LEITURA E CONVERSÃO
# ─────────────────────────────────────────────────────────────────────────────

# Lê e concatena CSVs de um padrão glob — aceita campos IBGE ou GAUL
load_csvs <- function(pattern) {
  files <- dir_ls(INPUT_MUN, glob = pattern)
  if (length(files) == 0) {
    message("  [AVISO] Nenhum arquivo encontrado: ", pattern)
    return(tibble())
  }
  message("  Carregando ", length(files), " arquivos: ", pattern)
  # Lê com col_types flexível para aceitar ambos os formatos
  map_dfr(files, \(f) read_csv(f, col_types = cols(.default = "?"), show_col_types = FALSE))
}

# Converte formato largo → longo (dashboard)
pivot_to_long <- function(df, territorio_tipo, nome_col, codigo_col = NULL,
                          estado_col = NULL, regiao_col = NULL, bioma_col = "Bioma") {
  bands <- names(BAND_MAP)
  
  df |>
    select(any_of(c("year", nome_col, codigo_col, bioma_col,
                     estado_col, regiao_col, all_of(bands)))) |>
    pivot_longer(
      cols      = any_of(bands),
      names_to  = "banda",
      values_to = "valor_co2e"
    ) |>
    filter(!is.na(valor_co2e), valor_co2e != 0) |>
    mutate(
      ano              = as.integer(year),
      territorio_tipo  = territorio_tipo,
      territorio_nome  = .data[[nome_col]],
      territorio_codigo = if (!is.null(codigo_col)) .data[[codigo_col]] else "",
      bioma            = if (!is.null(bioma_col) && bioma_col %in% names(df))
                           .data[[bioma_col]] else "",
      estado           = if (!is.null(estado_col) && estado_col %in% names(df))
                           .data[[estado_col]] else "",
      regiao           = if (!is.null(regiao_col) && regiao_col %in% names(df))
                           .data[[regiao_col]] else "",
      municipio        = if (territorio_tipo == "municipio") .data[[nome_col]] else "",
      categoria        = map_chr(banda, ~ BAND_MAP[[.x]][1]),
      subcategoria     = map_chr(banda, ~ BAND_MAP[[.x]][2]),
      tipo_fluxo       = map_chr(banda, ~ BAND_MAP[[.x]][3]),
      valor_co2e       = round(valor_co2e, 2),
      unidade          = UNIDADE,
      fonte            = FONTE,
      versao           = VERSAO
    ) |>
    select(ano, territorio_tipo, territorio_nome, territorio_codigo,
           bioma, estado, regiao, municipio,
           categoria, subcategoria, tipo_fluxo,
           valor_co2e, unidade, fonte, versao)
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. MUNICÍPIOS
# ─────────────────────────────────────────────────────────────────────────────
message("\n── Municípios ──────────────────────────────────────────────")
df_mun_raw <- load_csvs("*ybyra_emiss_mun_*.csv")

if (nrow(df_mun_raw) > 0) {
  
  # Normaliza campos (GAUL → IBGE ou mantém IBGE)
  df_mun_raw <- normalize_mun_fields(df_mun_raw)
  
  df_mun <- pivot_to_long(
    df          = df_mun_raw,
    territorio_tipo = "municipio",
    nome_col    = "NM_MUN",
    codigo_col  = "CD_MUN",
    estado_col  = "NM_UF",
    regiao_col  = "NM_REGIAO",
    bioma_col   = "Bioma"
  )
  
  message("  Municípios: ", format(nrow(df_mun), big.mark = "."), " linhas")
  
  # ── 3a. Estado — soma municípios por estado × ano × categoria ────────────
  df_estado <- df_mun |>
    group_by(ano, estado, regiao, bioma, categoria, subcategoria, tipo_fluxo) |>
    summarise(valor_co2e = sum(valor_co2e, na.rm = TRUE), .groups = "drop") |>
    mutate(
      territorio_tipo   = "estado",
      territorio_nome   = estado,
      territorio_codigo = estado,
      municipio         = "",
      unidade           = UNIDADE, fonte = FONTE, versao = VERSAO
    ) |>
    select(ano, territorio_tipo, territorio_nome, territorio_codigo,
           bioma, estado, regiao, municipio,
           categoria, subcategoria, tipo_fluxo,
           valor_co2e, unidade, fonte, versao)
  
  message("  Estados:    ", format(nrow(df_estado), big.mark = "."), " linhas")
  
  # ── 3b. Região ─────────────────────────────────────────────────────────────
  df_regiao <- df_mun |>
    group_by(ano, regiao, categoria, subcategoria, tipo_fluxo) |>
    summarise(valor_co2e = sum(valor_co2e, na.rm = TRUE), .groups = "drop") |>
    mutate(
      territorio_tipo   = "regiao",
      territorio_nome   = regiao,
      territorio_codigo = regiao,
      bioma = "", estado = "", municipio = "",
      unidade = UNIDADE, fonte = FONTE, versao = VERSAO
    ) |>
    select(ano, territorio_tipo, territorio_nome, territorio_codigo,
           bioma, estado, regiao, municipio,
           categoria, subcategoria, tipo_fluxo,
           valor_co2e, unidade, fonte, versao)
  
  message("  Regiões:    ", format(nrow(df_regiao), big.mark = "."), " linhas")
  
  # ── 3c. Brasil total (via municípios) ─────────────────────────────────────
  df_brasil_mun <- df_mun |>
    group_by(ano, categoria, subcategoria, tipo_fluxo) |>
    summarise(valor_co2e = sum(valor_co2e, na.rm = TRUE), .groups = "drop") |>
    mutate(
      territorio_tipo   = "pais",
      territorio_nome   = "Brasil",
      territorio_codigo = "BR",
      bioma = "", estado = "", regiao = "", municipio = "",
      unidade = UNIDADE, fonte = FONTE, versao = VERSAO
    ) |>
    select(ano, territorio_tipo, territorio_nome, territorio_codigo,
           bioma, estado, regiao, municipio,
           categoria, subcategoria, tipo_fluxo,
           valor_co2e, unidade, fonte, versao)
  
} else {
  df_mun <- df_estado <- df_regiao <- df_brasil_mun <- tibble()
  message("  [INFO] CSVs municipais não encontrados — pulando.")
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. BIOMAS (CSVs do GEE — mais precisos que agregação municipal)
# ─────────────────────────────────────────────────────────────────────────────
message("\n── Biomas ──────────────────────────────────────────────────")
df_biome_raw <- load_csvs("*ybyra_emiss_biome_*.csv")

if (nrow(df_biome_raw) > 0) {
  
  # Separa biomas individuais do Brasil total (linha 'Brasil' já vem do GEE)
  df_bioma <- df_biome_raw |>
    filter(Bioma != "Brasil") |>
    pivot_to_long(
      territorio_tipo = "bioma",
      nome_col        = "Bioma",
      bioma_col       = "Bioma"
    )
  
  df_brasil_gee <- df_biome_raw |>
    filter(Bioma == "Brasil") |>
    pivot_to_long(
      territorio_tipo   = "pais",
      nome_col          = "Bioma",
      bioma_col         = "Bioma"
    ) |>
    mutate(
      territorio_nome   = "Brasil",
      territorio_codigo = "BR",
      bioma             = ""
    )
  
  message("  Biomas: ", format(nrow(df_bioma), big.mark = "."), " linhas")
  message("  Brasil (GEE): ", format(nrow(df_brasil_gee), big.mark = "."), " linhas")
  
  # Usa Brasil do GEE se disponível (mais preciso); fallback = soma municipal
  df_brasil <- if (nrow(df_brasil_gee) > 0) df_brasil_gee else df_brasil_mun
  
} else {
  df_bioma <- tibble()
  df_brasil <- df_brasil_mun
  message("  [INFO] CSVs de bioma não encontrados — usando soma municipal como fallback.")
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. CONSOLIDAR TODOS OS RECORTES
# ─────────────────────────────────────────────────────────────────────────────
message("\n── Consolidando ────────────────────────────────────────────")

df_all <- bind_rows(
  df_mun,
  df_estado,
  df_regiao,
  df_bioma,
  df_brasil
) |>
  arrange(ano, territorio_tipo, territorio_nome, categoria)

message("  Total de linhas: ", format(nrow(df_all), big.mark = "."))

# ─────────────────────────────────────────────────────────────────────────────
# 6. VALIDAÇÃO RÁPIDA
# ─────────────────────────────────────────────────────────────────────────────
message("\n── Validação ───────────────────────────────────────────────")

message("  Anos disponíveis: ", paste(sort(unique(df_all$ano)), collapse = ", "))
message("  Tipos de território: ", paste(sort(unique(df_all$territorio_tipo)), collapse = ", "))
message("  Categorias: ", paste(sort(unique(df_all$categoria)), collapse = ", "))
message("  Tipos de fluxo: ", paste(sort(unique(df_all$tipo_fluxo)), collapse = ", "))
message("  Biomas: ", paste(sort(unique(df_all$bioma[df_all$bioma != ""])), collapse = ", "))

# Brasil — último ano disponível
ultimo_ano <- max(df_all$ano, na.rm = TRUE)
brasil_last <- df_all |>
  filter(territorio_tipo == "pais", ano == ultimo_ano) |>
  group_by(tipo_fluxo, categoria) |>
  summarise(total_Mt = sum(valor_co2e, na.rm = TRUE) / 1e6, .groups = "drop") |>
  arrange(tipo_fluxo, desc(total_Mt))

message("\n  Brasil ", ultimo_ano, " — por categoria (MtCO₂):")
print(brasil_last, n = 20)

total_em <- sum(brasil_last$total_Mt[brasil_last$tipo_fluxo == "Emissão"])
total_rm <- sum(brasil_last$total_Mt[brasil_last$tipo_fluxo == "Remoção"])
message("\n  Emissões totais:  ", round(total_em, 1), " MtCO₂")
message("  Remoções totais:  ", round(total_rm, 1), " MtCO₂")
message("  Balanço líquido:  ", round(total_rm - total_em, 1), " MtCO₂")

# ─────────────────────────────────────────────────────────────────────────────
# 7. EXPORTAR ARQUIVOS DE SAÍDA
# ─────────────────────────────────────────────────────────────────────────────
message("\n── Exportando ──────────────────────────────────────────────")

# Arquivo completo (todos os recortes juntos — para o dashboard)
write_csv(df_all, file.path(OUTPUT_DIR, "emissoes_remocoes_dashboard.csv"))
message("  Completo: emissoes_remocoes_dashboard.csv  (",
        round(file.size(file.path(OUTPUT_DIR, "emissoes_remocoes_dashboard.csv")) / 1e6, 1),
        " MB, ", format(nrow(df_all), big.mark = "."), " linhas)")

# Arquivos separados por tipo de território (para GitHub Pages — arquivos menores)
tipos <- unique(df_all$territorio_tipo)
walk(tipos, function(tipo) {
  sub <- filter(df_all, territorio_tipo == tipo)
  fname <- paste0("emissoes_remocoes_", tipo, ".csv")
  write_csv(sub, file.path(OUTPUT_DIR, fname))
  sz <- round(file.size(file.path(OUTPUT_DIR, fname)) / 1e6, 1)
  message("  ", str_pad(tipo, 12), ": ", fname, 
          "  (", sz, " MB, ", format(nrow(sub), big.mark = "."), " linhas)")
})

message("\n✓ Concluído. Copie os arquivos de '", OUTPUT_DIR,
        "/' para a pasta /data/ do dashboard.")
message("  Para carregar no dashboard, use:")
message("  fetch('./data/emissoes_remocoes_dashboard.csv')")

# ─────────────────────────────────────────────────────────────────────────────
# 8. EXEMPLO DE ANÁLISE RÁPIDA (descomente para usar)
# ─────────────────────────────────────────────────────────────────────────────

# # Série temporal de emissões e remoções — Brasil
# df_brasil_ts <- df_all |>
#   filter(territorio_tipo == "pais") |>
#   group_by(ano, tipo_fluxo) |>
#   summarise(total_Mt = sum(valor_co2e) / 1e6, .groups = "drop")
#
# library(ggplot2)
# ggplot(df_brasil_ts, aes(ano, total_Mt, color = tipo_fluxo)) +
#   geom_line(linewidth = 1.2) +
#   geom_point(size = 2) +
#   scale_color_manual(values = c("Emissão" = "#b84535", "Remoção" = "#3a7d55")) +
#   labs(title = "Brasil — Emissões e Remoções de Carbono Florestal",
#        subtitle = "YbYrá-BR v1.2",
#        x = NULL, y = "MtCO₂", color = NULL) +
#   theme_minimal(base_size = 13)
#
# # Contribuição por categoria — último ano
# df_cat <- df_all |>
#   filter(territorio_tipo == "pais", ano == ultimo_ano) |>
#   group_by(categoria, tipo_fluxo) |>
#   summarise(total_Mt = sum(valor_co2e) / 1e6, .groups = "drop")
#
# ggplot(df_cat, aes(reorder(categoria, total_Mt), total_Mt, fill = tipo_fluxo)) +
#   geom_col() +
#   coord_flip() +
#   scale_fill_manual(values = c("Emissão" = "#b84535", "Remoção" = "#3a7d55")) +
#   labs(title = paste("Emissões e Remoções por Categoria —", ultimo_ano),
#        x = NULL, y = "MtCO₂", fill = NULL) +
#   theme_minimal(base_size = 13)
