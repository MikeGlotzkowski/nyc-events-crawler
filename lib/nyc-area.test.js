import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBorough, boroughFromZip, findZip, findNeighborhoodName,
  manhattanStreetNeighborhood, nearestNeighborhood, resolveArea,
} from './nyc-area.js';

describe('normalizeBorough', () => {
  it('maps names, codes and "The Bronx" to canonical boroughs', () => {
    assert.equal(normalizeBorough('The Bronx'), 'Bronx');
    assert.equal(normalizeBorough('BX'), 'Bronx');
    assert.equal(normalizeBorough(' brooklyn '), 'Brooklyn');
    assert.equal(normalizeBorough('SI'), 'Staten Island');
    assert.equal(normalizeBorough('MN'), 'Manhattan');
  });
  it('returns null for anything else', () => {
    assert.equal(normalizeBorough('New Jersey'), null);
    assert.equal(normalizeBorough(null), null);
  });
});

describe('ZIP codes', () => {
  it('knows the borough of every NYC prefix', () => {
    assert.equal(boroughFromZip('10031'), 'Manhattan');
    assert.equal(boroughFromZip('10301'), 'Staten Island');
    assert.equal(boroughFromZip('10458'), 'Bronx');
    assert.equal(boroughFromZip('11238'), 'Brooklyn');
    assert.equal(boroughFromZip('11375'), 'Queens');
    assert.equal(boroughFromZip('11004'), 'Queens');
    assert.equal(boroughFromZip('11050'), null); // Nassau
  });
  it('reads the ZIP after the city, not a house number', () => {
    assert.deepEqual(findZip('675 Riverside Dr, New York, NY 10031'), { borough: 'Manhattan', neighborhood: 'Hamilton Heights' });
    assert.deepEqual(findZip('10 Grand Army Plaza, Brooklyn, New York, 11238, United States'), { borough: 'Brooklyn', neighborhood: 'Prospect Heights' });
    assert.equal(findZip('11201 Main Street'), null);
  });
});

describe('findNeighborhoodName', () => {
  it('finds a neighborhood named in an address', () => {
    assert.deepEqual(findNeighborhoodName('31-01 Ditmars Blvd, Astoria, NY'), { borough: 'Queens', neighborhood: 'Astoria' });
    assert.deepEqual(findNeighborhoodName('Somewhere in Bed-Stuy'), { borough: 'Brooklyn', neighborhood: 'Bedford-Stuyvesant' });
  });
  it('prefers the longer name', () => {
    assert.equal(findNeighborhoodName('East Harlem Art Walk')?.neighborhood, 'East Harlem');
    assert.equal(findNeighborhoodName('Kew Gardens Hills Library')?.neighborhood, 'Kew Gardens Hills');
  });
  it('ignores streets, rivers and bays that share a neighborhood name', () => {
    assert.equal(findNeighborhoodName('123 Flatbush Avenue'), null);
    assert.equal(findNeighborhoodName('Jamaica Bay Wildlife Refuge'), null);
    assert.equal(findNeighborhoodName('Harlem River Drive'), null);
  });
});

describe('manhattanStreetNeighborhood', () => {
  it('maps cross streets to neighborhoods', () => {
    assert.equal(manhattanStreetNeighborhood('W 68th Street & Riverside Blvd'), 'Upper West Side');
    assert.equal(manhattanStreetNeighborhood('EAST  104 STREET between THIRD AVENUE and SECOND AVENUE'), 'East Harlem');
    assert.equal(manhattanStreetNeighborhood('EAST   68 STREET between 1 AVENUE and 2 AVENUE'), 'Upper East Side');
    assert.equal(manhattanStreetNeighborhood('WEST  175 STREET between BROADWAY and WADSWORTH AVENUE'), 'Washington Heights');
  });
  it('splits upper Manhattan by avenue', () => {
    assert.equal(manhattanStreetNeighborhood('BROADWAY between WEST 113 STREET and WEST 116 STREET'), 'Morningside Heights');
    assert.equal(manhattanStreetNeighborhood('WEST 124 STREET between MOUNT MORRIS PARK WEST and MALCOLM X BOULEVARD'), 'Harlem');
    assert.equal(manhattanStreetNeighborhood('W 143rd Street & Riverside Drive'), 'Hamilton Heights');
  });
  it('returns null without a numbered street', () => {
    assert.equal(manhattanStreetNeighborhood('PARK PLACE between BROADWAY and CHURCH STREET'), null);
  });
});

describe('nearestNeighborhood', () => {
  it('finds the closest neighborhood center', () => {
    assert.deepEqual(nearestNeighborhood(40.6383, -73.9469), { borough: 'Brooklyn', neighborhood: 'Flatbush' });
  });
  it('stays inside a known borough', () => {
    assert.equal(nearestNeighborhood(40.7447, -73.9600, 'Manhattan')?.borough, 'Manhattan');
  });
  it('returns null outside NYC', () => {
    assert.equal(nearestNeighborhood(40.73, -74.17), null); // Newark
    assert.equal(nearestNeighborhood(null, null), null);
  });
});

describe('resolveArea', () => {
  it('uses the source defaults when the location says nothing', () => {
    assert.deepEqual(resolveArea({ borough: 'Queens', neighborhood: 'Sunnyside' }), { neighborhood: 'Sunnyside', borough: 'Queens' });
    assert.deepEqual(resolveArea({ name: 'Urban Farm', borough: 'The Bronx' }), { neighborhood: null, borough: 'Bronx' });
  });
  it('lets a known venue beat a ZIP in the same borough', () => {
    const area = resolveArea({ name: 'Hilltop Picnic Area, 11 Wards Meadow Loop, New York, NY, 10035' });
    assert.deepEqual(area, { neighborhood: "Randall's Island", borough: 'Manhattan' });
  });
  it('lets a ZIP in another borough beat the venue and the source', () => {
    const area = resolveArea({ name: 'Forest Park', address: '398 Jamaica Avenue, Brooklyn, NY, 11207', borough: 'Queens', neighborhood: 'Forest Park' });
    assert.deepEqual(area, { neighborhood: 'East New York', borough: 'Brooklyn' });
  });
  it('drops the source neighborhood when the borough changes', () => {
    assert.deepEqual(resolveArea({ name: 'Astoria Park', borough: 'Brooklyn', neighborhood: 'Greenpoint' }), { neighborhood: 'Astoria', borough: 'Queens' });
    assert.deepEqual(resolveArea({ name: 'Some bar, Bronx, NY', borough: 'Queens', neighborhood: 'Sunnyside' }), { neighborhood: null, borough: 'Bronx' });
  });
  it('parses Manhattan streets only in Manhattan', () => {
    assert.equal(resolveArea({ address: 'EAST 45 STREET between 2 AVENUE and 3 AVENUE', borough: 'MN' }).neighborhood, 'Midtown East');
    assert.equal(resolveArea({ address: 'WEST 175 STREET', borough: 'Bronx' }).neighborhood, null);
  });
  it('falls back to coordinates', () => {
    assert.deepEqual(resolveArea({ name: 'Nostrand Playground', lat: 40.6383, lng: -73.9469 }), { neighborhood: 'Flatbush', borough: 'Brooklyn' });
  });
});
