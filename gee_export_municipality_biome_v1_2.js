/**
 * =============================================================================
 * PROJETO  : YbYrá-BR — Estatísticas Pré-calculadas por Território
 * VERSAO   : v1_2
 * SCRIPT   : ybyra_precalc_statistics_v1_2.js
 *
 * RECORTES TERRITORIAIS (7 exports):
 *   1. Brasil        — dissolve dos biomas, região única
 *   2. Biomas        — 6 biomas IBGE
 *   3. Estados       — 27 UFs (MapBiomas Nível Político 2)
 *   4. TIs           — Territórios Indígenas
 *   5. UCs           — Unidades de Conservação
 *   6. Quilombos     — Territórios Quilombolas
 *   7. Municípios    — ~5.570 polígonos, divididos por estado (27 exports)
 *
 * ASSET DE ENTRADA:
 *   projects/ee-redd-brazil/assets/ybyra-br-model/emissions_removals_v1_2
 *   39 imagens (system:index = '1986'–'2024'), 25 bandas, tCO₂eq/pixel
 *
 * MÉTRICAS EXPORTADAS (por território × ano):
 *   total_primary_co2  emissões totais veg. primária
 *   edge_co2           efeito de borda
 *   logging_co2        exploração seletiva de madeira
 *   fire_co2           fogo / queimadas
 *   defor_co2          desmatamento veg. primária
 *   removal_sf_co2     remoções veg. secundária
 *   defor_sf_co2       desmatamento veg. secundária
 *   agc_sf_co2         estoque AGC veg. secundária
 *   net_co2            balanço líquido (calculado: total_primary
 *                      + defor_sf_co2 − removal_sf_co2)
 *
 * ESTRATÉGIA:
 *   Empilha as 39 imagens anuais em uma única Image multibanda
 *   (9 métricas × 39 anos = 351 bandas + area_ha = 352 bandas total).
 *   Uma única chamada reduceRegions() por tabela de território processa
 *   todos os polígonos simultaneamente — mínimo de tasks no GEE.
 *   O resultado wide (1 linha/polígono) é pivotado para long
 *   (1 linha/polígono × ano) via evaluate() client-side.
 *   Municípios são divididos por estado para evitar OOM.
 *
 * SAÍDAS (Google Drive — pasta 'YbYraBR_Statistics'):
 *   YbYraBR_brasil_v1_2.csv
 *   YbYraBR_biomas_v1_2.csv
 *   YbYraBR_estados_v1_2.csv
 *   YbYraBR_terras_indigenas_v1_2.csv
 *   YbYraBR_unidades_conservacao_v1_2.csv
 *   YbYraBR_quilombos_v1_2.csv
 *   YbYraBR_municipios/YbYraBR_municipios_uf<ID>_v1_2.csv  (27 arquivos)
 *
 * COLUNAS DE CADA CSV (formato long):
 *   id_territorio | nome_territorio | Ano | total_primary_co2 | edge_co2 |
 *   logging_co2 | fire_co2 | defor_co2 | removal_sf_co2 | defor_sf_co2 |
 *   agc_sf_co2 | net_co2
 *
 * -----------------------------------------------------------------------------
 * INSTITUICAO : IPAM Amazônia
 * PROJETO     : YbYrá-BR (CNPq 401741/2023-0)
 * RESPONSAVEL : Celso H. L. Silva-Junior
 * ATUALIZACAO : 2026-06-09
 * =============================================================================
 */


// ═══════════════════════════════════════════════════════════════════════════════
// 1. PARÂMETROS GLOBAIS
// ═══════════════════════════════════════════════════════════════════════════════

var IC_ASSET      = 'projects/ee-redd-brazil/assets/ybyra-br-model/emissions_removals_v1_2';
var MB_BASE       = 'projects/mapbiomas-territories/assets/TERRITORIES-OLD/LULC/BRAZIL/COLLECTION9/WORKSPACE/';
var VERSION       = 'v1_2';
var EXPORT_FOLDER = 'YbYraBR_Statistics';
var EXPORT_SCALE  = 30;     // resolução nativa — não alterar
var TILE_SCALE    = 4;      // aumentar para 8 se houver OOM em TIs / UCs grandes
var MAX_PIX       = 1e13;

var YEARS = [
  '1986','1987','1988','1989','1990','1991','1992','1993','1994','1995',
  '1996','1997','1998','1999','2000','2001','2002','2003','2004','2005',
  '2006','2007','2008','2009','2010','2011','2012','2013','2014','2015',
  '2016','2017','2018','2019','2020','2021','2022','2023','2024'
];

// Bandas presentes no asset (não incluir net_co2 — calculado aqui)
var DRIVER_BANDS = [
  'total_primary_co2',
  'edge_co2',
  'logging_co2',
  'fire_co2',
  'defor_co2',
  'removal_sf_co2',
  'defor_sf_co2',
  'agc_sf_co2'
];

// Ordem final das colunas no CSV (inclui net_co2 calculado)
var ALL_METRICS = DRIVER_BANDS.concat(['net_co2']);

// Colunas do CSV exportado
var SELECTORS = ['id_territorio', 'nome_territorio', 'Ano'].concat(ALL_METRICS);


// ═══════════════════════════════════════════════════════════════════════════════
// 2. ASSETS DE TERRITÓRIO
// ═══════════════════════════════════════════════════════════════════════════════

var ic         = ee.ImageCollection(IC_ASSET);
var biomas_fc  = ee.FeatureCollection('projects/mapbiomas-workspace/AUXILIAR/biomas_IBGE_250mil');

var fc_biomas  = biomas_fc;
var fc_estados = ee.FeatureCollection(MB_BASE + 'POLITICAL_LEVEL_2');
var fc_tis     = ee.FeatureCollection(MB_BASE + 'INDIGENOUS_TERRITORIES');
var fc_ucs     = ee.FeatureCollection(MB_BASE + 'PROTECTED_AREA');
var fc_quilomb = ee.FeatureCollection(MB_BASE + 'QUILOMBOS');
var fc_munic   = ee.FeatureCollection(MB_BASE + 'POLITICAL_LEVEL_3');


// ═══════════════════════════════════════════════════════════════════════════════
// 3. CONSTRUÇÃO DO STACK MULTIBANDA
//
//    Uma Image com 352 bandas:
//      area_ha             — área do pixel em hectares
//      <driver>_<ano>      — ex.: fire_co2_2023  (em tCO₂eq/pixel)
//      net_co2_<ano>       — balanço líquido calculado
//
//    Uso de .float() garante compatibilidade de tipo ao concatenar.
// ═══════════════════════════════════════════════════════════════════════════════

var stackedImage = ee.Image.cat(
  YEARS.map(function(yr) {
    var img = ee.Image(ic.filter(ee.Filter.eq('system:index', yr)).first());

    var net = img.select('total_primary_co2')
                 .add(img.select('defor_sf_co2'))
                 .subtract(img.select('removal_sf_co2'))
                 .rename('net_co2');

    return img.select(DRIVER_BANDS)
              .addBands(net)
              .rename(ALL_METRICS.map(function(b) { return b + '_' + yr; }))
              .float();
  })
).float();

var areaImg = ee.Image.pixelArea().divide(1e4).rename('area_ha').float();

// Imagem final: area_ha + 351 bandas de emissão/remoção
var fullStack = areaImg.addBands(stackedImage);

print('Stack total de bandas:', fullStack.bandNames().length());


// ═══════════════════════════════════════════════════════════════════════════════
// 4. FUNÇÕES AUXILIARES
// ═══════════════════════════════════════════════════════════════════════════════

// Executa reduceRegions sobre uma FeatureCollection
function reduceFC(fc) {
  return fullStack.reduceRegions({
    collection : fc,
    reducer    : ee.Reducer.sum(),
    scale      : EXPORT_SCALE,
    tileScale  : TILE_SCALE
  });
}

// Pivota resultado wide → long usando evaluate() client-side.
// geojson    : GeoJSON retornado pelo .evaluate()
// idProp     : nome da propriedade usada como ID do território
// nameProp   : nome da propriedade usada como nome do território
// Retorna    : ee.FeatureCollection em formato long, pronta para exportar
function wideToLong(geojson, idProp, nameProp) {
  var longFeats = [];

  geojson.features.forEach(function(feat) {
    var props = feat.properties;
    var tid   = (props[idProp]   !== undefined) ? props[idProp]   : (props['system:index'] || '?');
    var tname = (props[nameProp] !== undefined) ? props[nameProp] : String(tid);

    YEARS.forEach(function(yr) {
      var row = {
        'id_territorio'   : tid,
        'nome_territorio' : tname,
        'Ano'             : parseInt(yr, 10),
        'area_ha'         : props['area_ha'] || 0
      };
      ALL_METRICS.forEach(function(m) {
        row[m] = props[m + '_' + yr] || 0;
      });
      longFeats.push(ee.Feature(null, row));
    });
  });

  return ee.FeatureCollection(longFeats);
}

// Dispara um Export.table.toDrive a partir de uma FeatureCollection long
function exportLong(longFC, key, description) {
  Export.table.toDrive({
    collection    : longFC,
    description   : description,
    fileNamePrefix: description,
    fileFormat    : 'CSV',
    folder        : EXPORT_FOLDER,
    selectors     : SELECTORS.concat(['area_ha'])
  });
  print('✓ Export disparado: ' + description);
}

// Pipeline completo para uma FC sem divisão por UF
function processFC(fc, key, idProp, nameProp) {
  var desc = 'YbYraBR_' + key + '_' + VERSION;
  reduceFC(fc).evaluate(function(geojson, err) {
    if (err) { print('✗ Erro [' + key + ']:', err); return; }
    exportLong(wideToLong(geojson, idProp, nameProp), key, desc);
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// 5. EXPORT 1 — BRASIL (caso especial: região única, loop server-side por ano)
//
//    Brasil não tem polígono separado: usa dissolve dos biomas.
//    Com apenas 1 feature, não há necessidade de evaluate() — o loop
//    server-side sobre YEARS é suficiente e mais direto.
// ═══════════════════════════════════════════════════════════════════════════════

var brazil_geom = biomas_fc.geometry().dissolve();
var brazil_fc   = ee.FeatureCollection([
  ee.Feature(brazil_geom, { 'id_territorio': 1, 'nome_territorio': 'Brasil' })
]);

var brasil_wide = reduceFC(brazil_fc);

var tbl_brasil = ee.FeatureCollection(
  ee.List(YEARS).map(function(yr) {
    var feat = ee.Feature(brasil_wide.first());
    var props = ee.Dictionary({ 'id_territorio': 1, 'nome_territorio': 'Brasil',
                                 'Ano': ee.Number.parse(yr),
                                 'area_ha': feat.getNumber('area_ha') });
    ALL_METRICS.forEach(function(m) {
      props = props.set(m, feat.getNumber(m + '_' + yr));
    });
    return ee.Feature(null, props);
  })
);

Export.table.toDrive({
  collection    : tbl_brasil,
  description   : 'YbYraBR_brasil_' + VERSION,
  fileNamePrefix: 'YbYraBR_brasil_' + VERSION,
  fileFormat    : 'CSV',
  folder        : EXPORT_FOLDER,
  selectors     : SELECTORS.concat(['area_ha'])
});
print('✓ Export disparado: YbYraBR_brasil_' + VERSION);


// ═══════════════════════════════════════════════════════════════════════════════
// 6. EXPORT 2 — BIOMAS
//    6 polígonos — rápido, evaluate() sem problemas
// ═══════════════════════════════════════════════════════════════════════════════

processFC(fc_biomas, 'biomas', 'CD_Bioma', 'Bioma');


// ═══════════════════════════════════════════════════════════════════════════════
// 7. EXPORT 3 — ESTADOS
//    27 polígonos — evaluate() sem problemas
// ═══════════════════════════════════════════════════════════════════════════════

processFC(fc_estados, 'estados', 'territoryId', 'territoryName');


// ═══════════════════════════════════════════════════════════════════════════════
// 8. EXPORT 4 — TERRITÓRIOS INDÍGENAS
//    ~600 polígonos — evaluate() ok; aumentar TILE_SCALE para 8 se OOM
// ═══════════════════════════════════════════════════════════════════════════════

processFC(fc_tis, 'terras_indigenas', 'territoryId', 'territoryName');


// ═══════════════════════════════════════════════════════════════════════════════
// 9. EXPORT 5 — UNIDADES DE CONSERVAÇÃO
//    ~330 polígonos — evaluate() ok
// ═══════════════════════════════════════════════════════════════════════════════

processFC(fc_ucs, 'unidades_conservacao', 'territoryId', 'territoryName');


// ═══════════════════════════════════════════════════════════════════════════════
// 10. EXPORT 6 — QUILOMBOS
//    ~1600 polígonos — evaluate() pode demorar; aumentar TILE_SCALE se OOM
// ═══════════════════════════════════════════════════════════════════════════════

processFC(fc_quilomb, 'quilombos', 'territoryId', 'territoryName');


// ═══════════════════════════════════════════════════════════════════════════════
// 11. EXPORT 7 — MUNICÍPIOS
//    ~5.570 polígonos — dividido por UF para evitar OOM e timeout
//    Gera 27 CSVs em subpasta 'YbYraBR_Statistics/municipios'
//    Cada arquivo: YbYraBR_municipios_uf<stateId>_v1_2.csv
// ═══════════════════════════════════════════════════════════════════════════════

fc_munic.aggregate_array('stateId').distinct().sort().evaluate(function(ufIds, err) {
  if (err) { print('✗ Erro ao listar estados para municípios:', err); return; }

  print('Municípios: ' + ufIds.length + ' estados encontrados — disparando exports...');

  ufIds.forEach(function(ufId) {
    var fc_uf  = fc_munic.filter(ee.Filter.eq('stateId', ufId));
    var desc   = 'YbYraBR_municipios_uf' + ufId + '_' + VERSION;

    reduceFC(fc_uf).evaluate(function(geojson, err2) {
      if (err2) {
        print('✗ Erro municípios UF=' + ufId + ':', err2);
        return;
      }
      var longFC = wideToLong(geojson, 'territoryId', 'territoryName');
      Export.table.toDrive({
        collection    : longFC,
        description   : desc,
        fileNamePrefix: desc,
        fileFormat    : 'CSV',
        folder        : EXPORT_FOLDER + '/municipios',
        selectors     : SELECTORS.concat(['area_ha'])
      });
      print('  ✓ Municípios UF=' + ufId + ' disparado');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 12. PRÉVIA NO CONSOLE — validação rápida (escala grossa)
// ═══════════════════════════════════════════════════════════════════════════════

var PREVIEW_SCALE = 10000;

var preview = fullStack
  .select(['area_ha', 'total_primary_co2_2023', 'fire_co2_2023',
           'removal_sf_co2_2023', 'defor_co2_2023', 'net_co2_2023'])
  .reduceRegions({
    collection: fc_biomas,
    reducer   : ee.Reducer.sum(),
    scale     : PREVIEW_SCALE,
    tileScale : 2
  });

print('══ PRÉVIA POR BIOMA — 2023 (escala ' + PREVIEW_SCALE + 'm, valores aproximados) ══');
print(preview.select(['Bioma', 'area_ha', 'total_primary_co2_2023',
                      'fire_co2_2023', 'removal_sf_co2_2023',
                      'defor_co2_2023', 'net_co2_2023']));


// ═══════════════════════════════════════════════════════════════════════════════
// 13. VISUALIZAÇÃO NO MAPA
// ═══════════════════════════════════════════════════════════════════════════════

var img2023 = ee.Image(ic.filter(ee.Filter.eq('system:index', '2023')).first());
var net2023 = img2023.select('total_primary_co2')
                     .add(img2023.select('defor_sf_co2'))
                     .subtract(img2023.select('removal_sf_co2'))
                     .rename('net_co2');

Map.centerObject(biomas_fc, 4);

Map.addLayer(
  img2023.select('total_primary_co2').updateMask(img2023.select('total_primary_co2').gt(0)),
  { min: 0, max: 50, palette: ['ffffcc','ffeda0','feb24c','f03b20','bd0026'] },
  'Total emissões primárias 2023', false
);
Map.addLayer(
  img2023.select('fire_co2').updateMask(img2023.select('fire_co2').gt(0)),
  { min: 0, max: 20, palette: ['fff7bc','fec44f','d95f0e'] },
  'Fogo 2023', false
);
Map.addLayer(
  img2023.select('removal_sf_co2').updateMask(img2023.select('removal_sf_co2').gt(0)),
  { min: 0, max: 10, palette: ['f7fcf5','74c476','006d2c'] },
  'Remoção SF 2023', false
);
Map.addLayer(
  img2023.select('logging_co2').updateMask(img2023.select('logging_co2').gt(0)),
  { min: 0, max: 10, palette: ['fff7ec','fdd9a0','e3a857','5c3410'] },
  'Corte seletivo 2023', false
);
Map.addLayer(
  net2023,
  { min: -5, max: 50, palette: ['1a9641','ffffbf','d7191c'] },
  'Balanço líquido 2023', false
);
Map.addLayer(
  ee.Image().paint(biomas_fc, 0, 1.5),
  { palette: ['ffffff'] },
  'Biomas (contorno)', true
);
