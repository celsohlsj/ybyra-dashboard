/**
 * =============================================================================
 * PROJETO  : YbYrá-BR — Estatísticas Pré-calculadas por Território
 * VERSAO   : v1_2
 * SCRIPT   : ybyra_precalc_statistics_v1_2.js
 *
 * RECORTES TERRITORIAIS (7 grupos, 33 exports total):
 *   1. Brasil        — 1 CSV
 *   2. Biomas        — 1 CSV
 *   3. Estados       — 1 CSV
 *   4. TIs           — 1 CSV
 *   5. UCs           — 1 CSV
 *   6. Quilombos     — 1 CSV
 *   7. Municípios    — 27 CSVs (1 por estado)
 *
 * ARQUITETURA — 100% SERVER-SIDE (sem evaluate()):
 *   O problema com evaluate() + forEach é que o GEE Code Editor
 *   executa as chamadas de forma assíncrona e pode silenciosamente
 *   não disparar todos os exports, especialmente para FCs grandes.
 *
 *   Solução: todo o reshape wide → long é feito server-side:
 *     1. Para cada Feature da FC (polígono), gera 39 sub-Features
 *        (um por ano) via ee.FeatureCollection.map() + ee.List.map()
 *     2. O flatten() junta tudo em uma FC long pronta para Export
 *     3. Export.table.toDrive() é chamado diretamente — sem callbacks
 *
 *   Desvantagem: a FC long pode ser grande (ex.: 5570 municípios × 39 anos
 *   = 217.230 features), mas o GEE lida bem com isso em Export.
 *
 * MÉTRICAS (por território × ano):
 *   total_primary_co2 | edge_co2 | logging_co2 | fire_co2 | defor_co2 |
 *   removal_sf_co2 | defor_sf_co2 | agc_sf_co2 | net_co2
 *   net_co2 = total_primary_co2 + defor_sf_co2 − removal_sf_co2
 *
 * SAÍDAS (Google Drive — pasta 'YbYraBR_Statistics'):
 *   YbYraBR_brasil_v1_2.csv
 *   YbYraBR_biomas_v1_2.csv
 *   YbYraBR_estados_v1_2.csv
 *   YbYraBR_terras_indigenas_v1_2.csv
 *   YbYraBR_unidades_conservacao_v1_2.csv
 *   YbYraBR_quilombos_v1_2.csv
 *   municipios/YbYraBR_municipios_uf<ID>_v1_2.csv  (27 arquivos)
 *
 * COLUNAS:
 *   id_territorio | nome_territorio | Ano | area_ha |
 *   total_primary_co2 | edge_co2 | logging_co2 | fire_co2 | defor_co2 |
 *   removal_sf_co2 | defor_sf_co2 | agc_sf_co2 | net_co2
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
var EXPORT_SCALE  = 30;
var TILE_SCALE    = 4;   // aumentar para 8 se OOM em TIs / quilombos

var YEARS = ee.List([
  '1986','1987','1988','1989','1990','1991','1992','1993','1994','1995',
  '1996','1997','1998','1999','2000','2001','2002','2003','2004','2005',
  '2006','2007','2008','2009','2010','2011','2012','2013','2014','2015',
  '2016','2017','2018','2019','2020','2021','2022','2023','2024'
]);

// Para selectors do Export (JS puro, não ee.List)
var YEARS_JS = [
  '1986','1987','1988','1989','1990','1991','1992','1993','1994','1995',
  '1996','1997','1998','1999','2000','2001','2002','2003','2004','2005',
  '2006','2007','2008','2009','2010','2011','2012','2013','2014','2015',
  '2016','2017','2018','2019','2020','2021','2022','2023','2024'
];

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
var ALL_METRICS = DRIVER_BANDS.concat(['net_co2']);

var SELECTORS = ['id_territorio', 'nome_territorio', 'Ano', 'area_ha']
                .concat(ALL_METRICS);


// ═══════════════════════════════════════════════════════════════════════════════
// 2. ASSETS DE TERRITÓRIO
// ═══════════════════════════════════════════════════════════════════════════════

var ic        = ee.ImageCollection(IC_ASSET);
var biomas_fc = ee.FeatureCollection('projects/mapbiomas-workspace/AUXILIAR/biomas_IBGE_250mil');

var fc_biomas  = biomas_fc;
var fc_estados = ee.FeatureCollection(MB_BASE + 'POLITICAL_LEVEL_2');
var fc_tis     = ee.FeatureCollection(MB_BASE + 'INDIGENOUS_TERRITORIES');
var fc_ucs     = ee.FeatureCollection(MB_BASE + 'PROTECTED_AREA');
var fc_quilomb = ee.FeatureCollection(MB_BASE + 'QUILOMBOS');
var fc_munic   = ee.FeatureCollection(MB_BASE + 'POLITICAL_LEVEL_3');


// ═══════════════════════════════════════════════════════════════════════════════
// 3. IMAGENS ANUAIS PRÉ-CARREGADAS
//    Dicionário server-side: ano (string) → Image com métricas + net_co2
// ═══════════════════════════════════════════════════════════════════════════════

// Dicionário ee: chave = ano string, valor = Image
var imgByYear = ee.Dictionary(
  YEARS.iterate(function(yr, acc) {
    yr = ee.String(yr);
    var img = ee.Image(ic.filter(ee.Filter.eq('system:index', yr)).first());
    var net = img.select('total_primary_co2')
                 .add(img.select('defor_sf_co2'))
                 .subtract(img.select('removal_sf_co2'))
                 .rename('net_co2');
    var full = img.select(DRIVER_BANDS).addBands(net).float();
    return ee.Dictionary(acc).set(yr, full);
  }, ee.Dictionary({}))
);


// ═══════════════════════════════════════════════════════════════════════════════
// 4. FUNÇÃO CORE — buildLongFC
//
//    Recebe uma FeatureCollection de polígonos, idProp e nameProp.
//    Para cada Feature × Ano:
//      - Calcula area_ha via pixelArea
//      - Soma cada driver dentro do polígono (reduceRegion)
//      - Gera um Feature com as colunas no formato long
//    Retorna: ee.FeatureCollection pronta para Export
//
//    Estratégia: map() sobre a FC, e dentro de cada Feature map() sobre YEARS.
//    Assim tudo é lazy/server-side — nenhum evaluate() necessário.
// ═══════════════════════════════════════════════════════════════════════════════

function buildLongFC(fc, idProp, nameProp) {

  var longFC = fc.map(function(feat) {

    var geom  = feat.geometry();
    var tid   = feat.get(idProp);
    var tname = feat.get(nameProp);

    // Para cada ano: reduz todos os drivers dentro do polígono
    var yearFeats = YEARS.map(function(yr) {
      yr = ee.String(yr);
      var img = ee.Image(imgByYear.get(yr));

      // Área em ha
      var areaHa = ee.Image.pixelArea().divide(1e4)
                     .reduceRegion({
                       reducer  : ee.Reducer.sum(),
                       geometry : geom,
                       scale    : EXPORT_SCALE,
                       maxPixels: 1e13,
                       tileScale: TILE_SCALE
                     }).getNumber('area');

      // Soma de cada driver
      var sums = img.reduceRegion({
        reducer  : ee.Reducer.sum(),
        geometry : geom,
        scale    : EXPORT_SCALE,
        maxPixels: 1e13,
        tileScale: TILE_SCALE
      });

      return ee.Feature(null, {
        'id_territorio'   : tid,
        'nome_territorio' : tname,
        'Ano'             : ee.Number.parse(yr),
        'area_ha'         : areaHa,
        'total_primary_co2': sums.getNumber('total_primary_co2'),
        'edge_co2'        : sums.getNumber('edge_co2'),
        'logging_co2'     : sums.getNumber('logging_co2'),
        'fire_co2'        : sums.getNumber('fire_co2'),
        'defor_co2'       : sums.getNumber('defor_co2'),
        'removal_sf_co2'  : sums.getNumber('removal_sf_co2'),
        'defor_sf_co2'    : sums.getNumber('defor_sf_co2'),
        'agc_sf_co2'      : sums.getNumber('agc_sf_co2'),
        'net_co2'         : sums.getNumber('net_co2')
      });
    }); // fim YEARS.map

    return ee.FeatureCollection(yearFeats);

  }).flatten(); // achata FC de FCs → FC plana

  return longFC;
}


// ═══════════════════════════════════════════════════════════════════════════════
// 5. FUNÇÃO DE EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

function exportTerritory(fc, idProp, nameProp, key, folder) {
  var longFC = buildLongFC(fc, idProp, nameProp);
  var desc   = 'YbYraBR_' + key + '_' + VERSION;
  Export.table.toDrive({
    collection    : longFC,
    description   : desc,
    fileNamePrefix: desc,
    fileFormat    : 'CSV',
    folder        : folder || EXPORT_FOLDER,
    selectors     : SELECTORS
  });
  print('✓ Task submetida: ' + desc);
}


// ═══════════════════════════════════════════════════════════════════════════════
// 6. EXPORTS — 1 a 6 (Brasil, Biomas, Estados, TIs, UCs, Quilombos)
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. BRASIL ─────────────────────────────────────────────────────────────────
// Cria um Feature único com o dissolve dos biomas
var brazil_feat = ee.Feature(
  biomas_fc.geometry().dissolve(),
  { 'id_territorio': 0, 'nome_territorio': 'Brasil' }
);
exportTerritory(
  ee.FeatureCollection([brazil_feat]),
  'id_territorio', 'nome_territorio',
  'brasil'
);

// ── 2. BIOMAS ─────────────────────────────────────────────────────────────────
exportTerritory(fc_biomas, 'CD_Bioma', 'Bioma', 'biomas');

// ── 3. ESTADOS ────────────────────────────────────────────────────────────────
exportTerritory(fc_estados, 'territoryId', 'territoryName', 'estados');

// ── 4. TERRITÓRIOS INDÍGENAS ──────────────────────────────────────────────────
exportTerritory(fc_tis, 'territoryId', 'territoryName', 'terras_indigenas');

// ── 5. UNIDADES DE CONSERVAÇÃO ────────────────────────────────────────────────
exportTerritory(fc_ucs, 'territoryId', 'territoryName', 'unidades_conservacao');

// ── 6. QUILOMBOS ──────────────────────────────────────────────────────────────
exportTerritory(fc_quilomb, 'territoryId', 'territoryName', 'quilombos');


// ═══════════════════════════════════════════════════════════════════════════════
// 7. EXPORT — MUNICÍPIOS (dividido por estado)
//    ~5.570 polígonos × 39 anos = ~217k features por export inteiro.
//    Dividir por stateId gera 27 tasks menores (~200 municípios × 39 = ~7800
//    features cada), dentro dos limites de memória do GEE.
//
//    IDs dos estados (stateId = CD_GEOCUF):
//    RO=11 AC=12 AM=13 RR=14 PA=15 AP=16 TO=17
//    MA=21 PI=22 CE=23 RN=24 PB=25 PE=26 AL=27 SE=28 BA=29
//    MG=31 ES=32 RJ=33 SP=35 PR=41 SC=42 RS=43
//    MS=50 MT=51 GO=52 DF=53
// ═══════════════════════════════════════════════════════════════════════════════

var UF_IDS = [
  11, 12, 13, 14, 15, 16, 17,
  21, 22, 23, 24, 25, 26, 27, 28, 29,
  31, 32, 33, 35,
  41, 42, 43,
  50, 51, 52, 53
];

UF_IDS.forEach(function(ufId) {
  var fc_uf = fc_munic.filter(ee.Filter.eq('stateId', ufId));
  exportTerritory(
    fc_uf,
    'territoryId', 'territoryName',
    'municipios_uf' + ufId,
    EXPORT_FOLDER + '/municipios'
  );
});

print('✓ Municípios: ' + UF_IDS.length + ' tasks submetidas');


// ═══════════════════════════════════════════════════════════════════════════════
// 8. PRÉVIA NO CONSOLE
// ═══════════════════════════════════════════════════════════════════════════════

print('═══ PRÉVIA: biomas × 2023 ═══');
var yr_prev = '2023';
var img_prev = ee.Image(imgByYear.get(yr_prev));

var preview = img_prev
  .addBands(ee.Image.pixelArea().divide(1e4).rename('area_ha'))
  .reduceRegions({
    collection: fc_biomas,
    reducer   : ee.Reducer.sum(),
    scale     : 10000,
    tileScale : 2
  });

print(preview.select(['Bioma', 'area_ha', 'total_primary_co2',
                      'fire_co2', 'removal_sf_co2', 'net_co2']));


// ═══════════════════════════════════════════════════════════════════════════════
// 9. VISUALIZAÇÃO NO MAPA
// ═══════════════════════════════════════════════════════════════════════════════

var img2023 = ee.Image(imgByYear.get('2023'));

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
  img2023.select('net_co2'),
  { min: -5, max: 50, palette: ['1a9641','ffffbf','d7191c'] },
  'Balanço líquido 2023', false
);
Map.addLayer(
  ee.Image().paint(biomas_fc, 0, 1.5),
  { palette: ['ffffff'] },
  'Biomas (contorno)', true
);
