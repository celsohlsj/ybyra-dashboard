// =============================================================================
// YbYrá-BR | Export Emissions & Removals — Municipality × Biome
// Dashboard feeder script — v1.2
//
// CHANGELOG v1.2 (alinhado ao pipeline emissions_removals_v1_2):
//   • Fonte: emissions_removals_v1_2  (antes: v1_1)
//   • sl_co2 → logging_co2  (nome de banda atualizado)
//   • total_primary_co2 = edge + logging + fire + defor
//   • Novas colunas: logging_co2, logging_n
//   • net_balance_co2 = total_primary_co2 + defor_sf_co2 − removal_sf_co2
//
// ASSET DE MUNICÍPIOS:
//   O script usa FAO/GAUL/2015/level2 (dataset público, sempre disponível).
//   Se você tem acesso ao MapBiomas workspace, descomente a OPÇÃO A ou B
//   no bloco de configuração abaixo para obter códigos IBGE oficiais (CD_MUN).
//
// ─────────────────────────────────────────────────────────────────────────────
// DIAGNÓSTICO: rode este bloco para descobrir assets disponíveis no seu projeto
// ─────────────────────────────────────────────────────────────────────────────
// var assets = ee.data.listAssets('projects/mapbiomas-workspace/AUXILIAR');
// print('Assets disponíveis:', assets);
//
// Se encontrar o asset de municípios, substitua o caminho na OPÇÃO A abaixo
// e troque o bloco de municípios para usar os campos corretos (CD_MUN, NM_MUN,
// NM_UF, SIGLA_UF), removendo o bloco de normalização GAUL.
// =============================================================================
//
// Bandas disponíveis na coleção v1_2 (Mg CO₂ pixel⁻¹ yr⁻¹):
//   edge_co2         — efeito de borda
//   logging_co2      — corte seletivo  [p(n) = 0.196 × exp(−0.0782 × (n−1))]
//   fire_co2         — fogo
//   defor_co2        — desmatamento floresta primária
//   total_primary_co2 — soma dos quatro acima
//   defor_sf_co2     — desmatamento floresta secundária
//   removal_sf_co2   — remoção floresta secundária
//   agc_sf_co2       — estoque AGC floresta secundária (Mg CO₂ pixel⁻¹)
//   logging_n        — ordem de recorrência do evento de corte (1,2,3...)
//
// Saída (Google Drive — pasta YbYrá-BR_Dashboard):
//   ybyra_emiss_mun_YYYY.csv    — por município (1 arquivo por ano)
//   ybyra_emiss_biome_YYYY.csv  — por bioma     (1 arquivo por ano)
//
// Colunas do CSV de municípios:
//   year, CD_MUN, NM_MUN, NM_UF, SIGLA_UF, NM_REGIAO, Bioma,
//   edge_co2, logging_co2, fire_co2, defor_co2, total_primary_co2,
//   defor_sf_co2, removal_sf_co2, agc_sf_co2,
//   net_balance_co2, logging_n_mean, pixel_area_ha
//
// Colunas do CSV de biomas:
//   year, Bioma,
//   edge_co2, logging_co2, fire_co2, defor_co2, total_primary_co2,
//   defor_sf_co2, removal_sf_co2, agc_sf_co2,
//   net_balance_co2, logging_n_mean, pixel_area_ha
//
// Estratégia de memória:
//   scale = 500 m → erro < 0.5% para somas regionais
//   tileScale = 16 → evita OOM em geometrias grandes
//   loop client-side por ano → 1 task por ano por recorte
//
// Autores: YbYrá-BR
// Versão: 1.2 — 2025
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 0. CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────────────────────
var START_YEAR   = 1986;
var END_YEAR     = 2024;
var SCALE        = 500;
var TILE_SCALE   = 16;
var DRIVE_FOLDER = 'YbYrá-BR_Dashboard';

// RUN_MODE: 'MUNICIPALITY' | 'BIOME' | 'BOTH'
// Recomendação: rode 'BIOME' primeiro para validar, depois 'MUNICIPALITY' em
// blocos de 10 anos (ex: 1986-1995, 1996-2005, 2006-2015, 2016-2024)
var RUN_MODE = 'BIOME';

// ─────────────────────────────────────────────────────────────────────────────
// 1. ASSETS
// ─────────────────────────────────────────────────────────────────────────────

// Coleção principal — v1_2 (inclui logging_co2)
var col = ee.ImageCollection(
  'projects/ee-redd-brazil/assets/ybyra-br-model/emissions_removals_v1_2'
);

// =============================================================================
// MUNICÍPIOS — asset IBGE via GAUL / FAO ou alternativas públicas no GEE
//
// Opções em ordem de preferência (descomente apenas uma):
//
// OPÇÃO A — IBGE 2022 via projeto ee-redd-brazil (recomendado se você tem acesso)
//   'projects/ee-redd-brazil/assets/auxiliar/municipios_brasil_2022'
//
// OPÇÃO B — MapBiomas workspace (requer acesso ao workspace)
//   'projects/mapbiomas-workspace/AUXILIAR/municipios_2022'
//
// OPÇÃO C — FAO GAUL Level 2 (público, sem necessidade de acesso especial)
//   ee.FeatureCollection('FAO/GAUL/2015/level2').filter(ee.Filter.eq('ADM0_NAME','Brazil'))
//   Campos: ADM2_NAME (município), ADM1_NAME (estado), ADM2_CODE
//
// OPÇÃO D — IBGE via asset público do TerraBrasilis / MapBiomas público
//   'projects/mapbiomas-public/assets/territories/territories_2022'
//   filter: territorio_tipo == 'municipio'  (se disponível)
//
// ── USANDO OPÇÃO C (FAO GAUL) — SEMPRE DISPONÍVEL NO GEE ─────────────────────
// Campos: ADM2_NAME → NM_MUN, ADM1_NAME → NM_UF, ADM2_CODE → CD_MUN
// =============================================================================

// Municípios do Brasil — FAO GAUL Level 2 (dataset público)
var gaul2 = ee.FeatureCollection('FAO/GAUL/2015/level2')
              .filter(ee.Filter.eq('ADM0_NAME', 'Brazil'));

// Normalizar campos para o padrão do pipeline
var municipalities = gaul2.map(function(feat) {
  return feat.set({
    'CD_MUN':  feat.get('ADM2_CODE'),   // código numérico GAUL
    'NM_MUN':  feat.get('ADM2_NAME'),   // nome do município
    'NM_UF':   feat.get('ADM1_NAME'),   // nome do estado
    'SIGLA_UF': ''                       // GAUL não tem sigla — preenchida abaixo
  });
});

// Mapa nome do estado → sigla UF (necessário pois GAUL usa nome completo)
var ESTADO_SIGLA = ee.Dictionary({
  'Acre':'AC','Alagoas':'AL','Amapá':'AP','Amazonas':'AM','Bahia':'BA',
  'Ceará':'CE','Distrito Federal':'DF','Espírito Santo':'ES','Goiás':'GO',
  'Maranhão':'MA','Mato Grosso':'MT','Mato Grosso do Sul':'MS',
  'Minas Gerais':'MG','Pará':'PA','Paraíba':'PB','Paraná':'PR',
  'Pernambuco':'PE','Piauí':'PI','Rio de Janeiro':'RJ',
  'Rio Grande do Norte':'RN','Rio Grande do Sul':'RS','Rondônia':'RO',
  'Roraima':'RR','Santa Catarina':'SC','São Paulo':'SP',
  'Sergipe':'SE','Tocantins':'TO'
});

municipalities = municipalities.map(function(feat) {
  var nmUF  = feat.getString('NM_UF');
  var sigla = ESTADO_SIGLA.get(nmUF, 'ZZ');
  return feat.set('SIGLA_UF', sigla);
});

print('Municípios (GAUL amostra):', municipalities.limit(3));
print('Total municípios:', municipalities.size());

// Biomas IBGE 1:250.000
var biomesFC = ee.FeatureCollection(
  'projects/mapbiomas-workspace/AUXILIAR/biomas_IBGE_250mil'
).select(['Bioma']);

// Bioma rasterizado → usar código numérico (reduceToImage só aceita números)
// String fields causam: "Reducer input must be a number"
var BIOME_CODES = ee.Dictionary({
  'Amazônia':       1,
  'Cerrado':        2,
  'Mata Atlântica': 3,
  'Caatinga':       4,
  'Pampa':          5,
  'Pantanal':       6
});
var BIOME_NAMES = ee.Dictionary({
  '1': 'Amazônia',
  '2': 'Cerrado',
  '3': 'Mata Atlântica',
  '4': 'Caatinga',
  '5': 'Pampa',
  '6': 'Pantanal'
});

// Adiciona campo numérico ao FeatureCollection de biomas antes de rasterizar
var biomesNumeric = biomesFC.map(function(feat) {
  var code = ee.Number(BIOME_CODES.get(feat.getString('Bioma'), 0));
  return feat.set('bioma_code', code);
});

var biomeImg = biomesNumeric.reduceToImage({
  properties: ['bioma_code'],
  reducer: ee.Reducer.first()
}).rename('bioma_code');

// ─────────────────────────────────────────────────────────────────────────────
// 2. LOOKUP: UF → Região
// ─────────────────────────────────────────────────────────────────────────────
var REGIAO_MAP = ee.Dictionary({
  'AC':'Norte',   'AP':'Norte',   'AM':'Norte',   'PA':'Norte',
  'RO':'Norte',   'RR':'Norte',   'TO':'Norte',
  'AL':'Nordeste','BA':'Nordeste','CE':'Nordeste','MA':'Nordeste',
  'PB':'Nordeste','PE':'Nordeste','PI':'Nordeste','RN':'Nordeste',
  'SE':'Nordeste',
  'DF':'Centro-Oeste','GO':'Centro-Oeste','MT':'Centro-Oeste','MS':'Centro-Oeste',
  'ES':'Sudeste', 'MG':'Sudeste', 'RJ':'Sudeste', 'SP':'Sudeste',
  'PR':'Sul',     'RS':'Sul',     'SC':'Sul'
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. MUNICÍPIOS — adicionar bioma dominante e região
// ─────────────────────────────────────────────────────────────────────────────
var munWithBiome = municipalities.map(function(feat) {
  // Extrai código numérico do bioma dominante (modo espacial)
  var code = biomeImg.reduceRegion({
    reducer:  ee.Reducer.mode(),
    geometry: feat.geometry(),
    scale:    500,
    maxPixels: 1e9
  }).get('bioma_code');

  // Converte código → nome do bioma (via dicionário server-side)
  var codeStr   = ee.Number(code).int().format('%d');
  var biomeName = ee.String(BIOME_NAMES.get(codeStr, 'Outros'));
  return feat.set('Bioma', biomeName);
});

var munReady = munWithBiome.map(function(feat) {
  var sigla  = feat.getString('SIGLA_UF');
  var regiao = REGIAO_MAP.get(sigla, 'N/A');
  return feat.set('NM_REGIAO', regiao);
});

print('Municípios prontos (amostra):', munReady.limit(3));

// ─────────────────────────────────────────────────────────────────────────────
// 4. UTILITÁRIO — banda segura com fallback zero
// ─────────────────────────────────────────────────────────────────────────────
// Necessário porque logging_co2 pode não existir em anos anteriores a 1988
function safeBand(img, bandName) {
  var hasBand = img.bandNames().contains(bandName);
  return ee.Image(ee.Algorithms.If(
    hasBand,
    img.select(bandName),
    ee.Image.constant(0).rename(bandName)
  ));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. EXPORTAÇÃO POR MUNICÍPIO
// ─────────────────────────────────────────────────────────────────────────────
function exportByMunicipality(year) {
  var yr    = ee.Number(year).toInt();
  var yrStr = ee.String(yr);

  var img = col.filter(ee.Filter.eq('year', yr)).first();

  // Bandas de emissão — logging_co2 substitui sl_co2 na v1_2
  var edge_co2    = safeBand(img, 'edge_co2');
  var logging_co2 = safeBand(img, 'logging_co2');   // NEW v1.2
  var fire_co2    = safeBand(img, 'fire_co2');
  var defor_co2   = safeBand(img, 'defor_co2');
  var defor_sf    = safeBand(img, 'defor_sf_co2');
  var removal_sf  = safeBand(img, 'removal_sf_co2');
  var agc_sf      = safeBand(img, 'agc_sf_co2');
  var logging_n   = safeBand(img, 'logging_n');      // NEW v1.2 — recorrência média

  // total_primary já calculado pelo pipeline; recalcular garante consistência
  var total_primary = edge_co2.add(logging_co2).add(fire_co2).add(defor_co2)
                               .rename('total_primary_co2');

  // Balanço líquido: emissões primárias + emissão SF − remoção SF
  var net_balance = total_primary.add(defor_sf).subtract(removal_sf)
                                  .rename('net_balance_co2');

  // Área total de pixels válidos (ha)
  var pixelArea_ha = ee.Image.pixelArea().divide(10000).rename('pixel_area_ha');

  var stack = edge_co2
    .addBands(logging_co2)
    .addBands(fire_co2)
    .addBands(defor_co2)
    .addBands(total_primary)
    .addBands(defor_sf)
    .addBands(removal_sf)
    .addBands(agc_sf)
    .addBands(net_balance)
    .addBands(logging_n)
    .addBands(pixelArea_ha);

  // reduceRegions — soma para emissões, média para logging_n
  var reduced = stack
    .select(['edge_co2','logging_co2','fire_co2','defor_co2',
             'total_primary_co2','defor_sf_co2','removal_sf_co2',
             'agc_sf_co2','net_balance_co2','pixel_area_ha'])
    .reduceRegions({
      collection: munReady,
      reducer:    ee.Reducer.sum(),
      scale:      SCALE,
      tileScale:  TILE_SCALE
    });

  // Média de logging_n separada (sum não faz sentido para ordem de evento)
  var reducedN = stack.select(['logging_n']).reduceRegions({
    collection: munReady,
    reducer:    ee.Reducer.mean(),
    scale:      SCALE,
    tileScale:  TILE_SCALE
  });

  // Junta logging_n_mean no resultado principal
  var nDict = reducedN.reduceColumns(
    ee.Reducer.toList(2), ['CD_MUN', 'logging_n']
  );

  var result = reduced.map(function(feat) {
    return ee.Feature(null, {
      year:              yr,
      CD_MUN:            feat.get('CD_MUN'),
      NM_MUN:            feat.get('NM_MUN'),
      NM_UF:             feat.get('NM_UF'),
      SIGLA_UF:          feat.get('SIGLA_UF'),
      NM_REGIAO:         feat.get('NM_REGIAO'),
      Bioma:             feat.get('Bioma'),
      edge_co2:          feat.get('edge_co2'),
      logging_co2:       feat.get('logging_co2'),
      fire_co2:          feat.get('fire_co2'),
      defor_co2:         feat.get('defor_co2'),
      total_primary_co2: feat.get('total_primary_co2'),
      defor_sf_co2:      feat.get('defor_sf_co2'),
      removal_sf_co2:    feat.get('removal_sf_co2'),
      agc_sf_co2:        feat.get('agc_sf_co2'),
      net_balance_co2:   feat.get('net_balance_co2'),
      pixel_area_ha:     feat.get('pixel_area_ha')
    });
  });

  Export.table.toDrive({
    collection:     result,
    description:    'ybyra_emiss_mun_' + year,
    folder:         DRIVE_FOLDER,
    fileNamePrefix: 'ybyra_emiss_mun_' + year,
    fileFormat:     'CSV',
    selectors: [
      'year','CD_MUN','NM_MUN','NM_UF','SIGLA_UF','NM_REGIAO','Bioma',
      'edge_co2','logging_co2','fire_co2','defor_co2','total_primary_co2',
      'defor_sf_co2','removal_sf_co2','agc_sf_co2',
      'net_balance_co2','pixel_area_ha'
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. EXPORTAÇÃO POR BIOMA
// ─────────────────────────────────────────────────────────────────────────────
function exportByBiome(year) {
  var yr    = ee.Number(year).toInt();
  var yrStr = ee.String(yr);

  var img = col.filter(ee.Filter.eq('year', yr)).first();

  var edge_co2    = safeBand(img, 'edge_co2');
  var logging_co2 = safeBand(img, 'logging_co2');
  var fire_co2    = safeBand(img, 'fire_co2');
  var defor_co2   = safeBand(img, 'defor_co2');
  var defor_sf    = safeBand(img, 'defor_sf_co2');
  var removal_sf  = safeBand(img, 'removal_sf_co2');
  var agc_sf      = safeBand(img, 'agc_sf_co2');
  var logging_n   = safeBand(img, 'logging_n');

  var total_primary = edge_co2.add(logging_co2).add(fire_co2).add(defor_co2)
                               .rename('total_primary_co2');
  var net_balance   = total_primary.add(defor_sf).subtract(removal_sf)
                                    .rename('net_balance_co2');
  var pixelArea_ha  = ee.Image.pixelArea().divide(10000).rename('pixel_area_ha');

  var stack = edge_co2
    .addBands(logging_co2)
    .addBands(fire_co2)
    .addBands(defor_co2)
    .addBands(total_primary)
    .addBands(defor_sf)
    .addBands(removal_sf)
    .addBands(agc_sf)
    .addBands(net_balance)
    .addBands(pixelArea_ha);

  // ── Biomas individuais ────────────────────────────────────────────────────
  var reducedBiomes = stack.reduceRegions({
    collection: biomesFC,
    reducer:    ee.Reducer.sum(),
    scale:      SCALE,
    tileScale:  TILE_SCALE
  });

  // ── Brasil total ──────────────────────────────────────────────────────────
  var brazilGeom = biomesFC.geometry().dissolve({ maxError: 100 });
  var brazilFeat = ee.Feature(brazilGeom, { 'Bioma': 'Brasil' });
  var reducedBrazil = stack.reduceRegions({
    collection: ee.FeatureCollection([brazilFeat]),
    reducer:    ee.Reducer.sum(),
    scale:      SCALE,
    tileScale:  TILE_SCALE
  });

  var all = reducedBiomes.merge(reducedBrazil);

  var result = all.map(function(feat) {
    return ee.Feature(null, {
      year:              yr,
      Bioma:             feat.get('Bioma'),
      edge_co2:          feat.get('edge_co2'),
      logging_co2:       feat.get('logging_co2'),
      fire_co2:          feat.get('fire_co2'),
      defor_co2:         feat.get('defor_co2'),
      total_primary_co2: feat.get('total_primary_co2'),
      defor_sf_co2:      feat.get('defor_sf_co2'),
      removal_sf_co2:    feat.get('removal_sf_co2'),
      agc_sf_co2:        feat.get('agc_sf_co2'),
      net_balance_co2:   feat.get('net_balance_co2'),
      pixel_area_ha:     feat.get('pixel_area_ha')
    });
  });

  Export.table.toDrive({
    collection:     result,
    description:    'ybyra_emiss_biome_' + year,
    folder:         DRIVE_FOLDER,
    fileNamePrefix: 'ybyra_emiss_biome_' + year,
    fileFormat:     'CSV',
    selectors: [
      'year','Bioma',
      'edge_co2','logging_co2','fire_co2','defor_co2','total_primary_co2',
      'defor_sf_co2','removal_sf_co2','agc_sf_co2',
      'net_balance_co2','pixel_area_ha'
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. DISPARO DAS TASKS (loop client-side)
// ─────────────────────────────────────────────────────────────────────────────
// Recomendação de execução por blocos (municípios):
//   Bloco 1: START=1986 END=1995
//   Bloco 2: START=1996 END=2005
//   Bloco 3: START=2006 END=2015
//   Bloco 4: START=2016 END=2024
//
// Para biomas: pode rodar 1986-2024 de uma vez (7 biomas + Brasil = 8 linhas/ano)

for (var y = START_YEAR; y <= END_YEAR; y++) {
  if (RUN_MODE === 'MUNICIPALITY' || RUN_MODE === 'BOTH') exportByMunicipality(y);
  if (RUN_MODE === 'BIOME'        || RUN_MODE === 'BOTH') exportByBiome(y);
}

print('Tasks configuradas:', (END_YEAR - START_YEAR + 1),
      'anos ×',
      RUN_MODE === 'BOTH' ? '2 recortes' : '1 recorte');
print('Coleta de origem: emissions_removals_v1_2');
print('Verifique a aba Tasks e submeta as exportações.');

// ─────────────────────────────────────────────────────────────────────────────
// 8. VISUALIZAÇÃO DE DIAGNÓSTICO (último ano)
// ─────────────────────────────────────────────────────────────────────────────
var imgDebug = col.filter(ee.Filter.eq('year', END_YEAR)).first();
Map.centerObject(biomesFC, 4);
Map.setOptions('HYBRID');

Map.addLayer(
  imgDebug.select('defor_co2'),
  { min:0, max:1e8, palette:['#f7f7f7','#fee0d2','#fc9272','#de2d26','#a50f15'] },
  'Desmatamento CO₂ ' + END_YEAR
);
Map.addLayer(
  imgDebug.select('logging_co2'),
  { min:0, max:3e7, palette:['#f7fbff','#c6dbef','#6baed6','#2171b5','#084594'] },
  'Corte seletivo CO₂ ' + END_YEAR
);
Map.addLayer(
  imgDebug.select('fire_co2'),
  { min:0, max:5e7, palette:['#fff7ec','#fee8c8','#fdbb84','#e34a33','#b30000'] },
  'Fogo CO₂ ' + END_YEAR
);
Map.addLayer(
  imgDebug.select('removal_sf_co2'),
  { min:0, max:3e7, palette:['#f7fcf5','#c7e9c0','#74c476','#238b45','#00441b'] },
  'Remoção FS CO₂ ' + END_YEAR
);
Map.addLayer(
  imgDebug.select('logging_n'),
  { min:1, max:5, palette:['#ffffb2','#fecc5c','#fd8d3c','#f03b20','#bd0026'] },
  'Corte seletivo — n recorrências ' + END_YEAR,
  false
);
Map.addLayer(
  biomesFC.style({ color:'#1a1a1a', width:1, fillColor:'00000000' }),
  {}, 'Biomas IBGE'
);

// ─────────────────────────────────────────────────────────────────────────────
// NOTAS DE INTEGRAÇÃO COM O DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
//
// MAPEAMENTO CSV → DASHBOARD (categoria no dashboard):
//   defor_co2      → categoria = 'Desmatamento',    subcategoria = 'Floresta primária',   tipo_fluxo = 'Emissão'
//   logging_co2    → categoria = 'Corte seletivo',  subcategoria = 'Exploração madeireira',tipo_fluxo = 'Emissão'
//   fire_co2       → categoria = 'Fogo',            subcategoria = 'Degradação por fogo', tipo_fluxo = 'Emissão'
//   edge_co2       → categoria = 'Degradação florestal', subcategoria = 'Efeito de borda',tipo_fluxo = 'Emissão'
//   defor_sf_co2   → categoria = 'Desmatamento',    subcategoria = 'Floresta secundária', tipo_fluxo = 'Emissão'
//   removal_sf_co2 → categoria = 'Floresta secundária', subcategoria = 'Regeneração natural', tipo_fluxo = 'Remoção'
//
// UNIDADES:
//   Todas as bandas *_co2 → Mg CO₂ pixel⁻¹ yr⁻¹  →  soma = Mg CO₂ yr⁻¹ por território
//   1 Mg CO₂ = 1 t CO₂ (mega = 10⁶ g = 1 t)
//   Dashboard usa MgCO2e (unidade consistente com o pipeline)
//
// CONSOLIDAÇÃO: use o script R  ybyra_consolidate.R
