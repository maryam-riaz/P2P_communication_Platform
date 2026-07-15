// Simplified offline map data for Pakistan provinces and major cities.
// This allows 100% offline outline maps with zero assets size and fully customizable shapes.

export interface ProvinceBoundary {
  name: string;
  color: string;
  coordinates: [number, number][]; // [lat, lng]
}

export interface CityData {
  name: string;
  lat: number;
  lng: number;
  description: string;
}

export const PAKISTAN_PROVINCES: ProvinceBoundary[] = [
  {
    name: 'Balochistan',
    color: '#00E676', // Greenish neon
    coordinates: [
      [25.12, 62.32], // Gwadar area
      [25.00, 66.00], // Coast near Lasbela
      [25.90, 66.70], // East border with Sindh
      [27.80, 67.20],
      [28.70, 68.00],
      [28.70, 69.50], // Northeast tip (Sui/Dera Bugti)
      [31.50, 70.00], // Border with Punjab
      [32.00, 69.90],
      [31.80, 68.50], // Northern border
      [31.20, 66.50], // Chaman area (border with Afghan)
      [30.20, 66.30],
      [29.50, 63.80],
      [29.80, 61.50], // West tip border with Iran
      [25.00, 61.50], // Jiwani coastal corner
      [25.12, 62.32]  // Close loop
    ]
  },
  {
    name: 'Sindh',
    color: '#FFEA00', // Yellow neon
    coordinates: [
      [23.70, 68.10], // Sir Creek coastal corner
      [24.80, 66.70], // Karachi / Cape Monze
      [25.90, 66.70], // West boundary with Balochistan
      [27.80, 67.20],
      [28.70, 68.00],
      [28.50, 69.00], // North border with Punjab
      [28.30, 69.70],
      [28.60, 70.10],
      [27.90, 70.90], // East border with India (Thar desert)
      [26.50, 70.20],
      [24.70, 71.10],
      [24.10, 71.00],
      [23.70, 68.10]  // Close loop
    ]
  },
  {
    name: 'Punjab',
    color: '#FF6D00', // Orange neon
    coordinates: [
      [28.50, 69.00], // South junction with Sindh
      [28.70, 69.50], // West junction with Balochistan
      [31.50, 70.00],
      [32.00, 69.90],
      [32.80, 71.10], // Northwest boundary with KP
      [33.10, 71.70],
      [33.90, 72.30], // Attock area
      [33.80, 72.80], // Taxila area near Rawalpindi
      [34.00, 73.40], // Murree border with AJK
      [32.90, 74.00], // Sialkot/Jammu border
      [32.50, 74.70],
      [31.50, 74.50], // Lahore border
      [31.00, 74.20],
      [29.90, 72.80],
      [28.60, 70.10], // South-east junction with Sindh
      [28.50, 69.00]  // Close loop
    ]
  },
  {
    name: 'Khyber Pakhtunkhwa',
    color: '#00B0FF', // Sky Blue neon
    coordinates: [
      [32.00, 69.90], // South tip near DI Khan / Balochistan
      [32.80, 71.10], // East boundary with Punjab
      [33.10, 71.70],
      [33.90, 72.30],
      [34.00, 73.40], // East boundary with AJK
      [34.50, 73.50],
      [35.10, 73.80], // Kaghan valley area
      [36.80, 73.00], // Chitral northern tip (Wakhan corridor border)
      [36.20, 71.60],
      [35.50, 71.30],
      [34.20, 71.00], // Khyber Pass area
      [33.80, 69.90], // Kurram Agency area
      [32.40, 69.30], // South Waziristan border
      [32.00, 69.90]  // Close loop
    ]
  },
  {
    name: 'Gilgit-Baltistan & AJK',
    color: '#D500F9', // Purple/Magenta neon
    coordinates: [
      [34.00, 73.40], // Murree junction
      [34.50, 73.50], // KP border
      [35.10, 73.80],
      [36.80, 73.00], // Northern tip of Chitral junction
      [37.00, 74.50], // Khunjerab Pass / China border
      [37.00, 75.50],
      [36.00, 76.50], // Karakoram range (K2 area)
      [35.00, 77.00],
      [34.20, 77.50], // Line of Control / Ladakh border
      [34.00, 75.00],
      [33.50, 74.00], // Azad Kashmir border
      [33.00, 73.80],
      [34.00, 73.40]  // Close loop
    ]
  }
];

export const PAKISTAN_CITIES: CityData[] = [
  { name: 'Islamabad (Capital)', lat: 33.6844, lng: 73.0479, description: 'National capital, SOSify Command HQ' },
  { name: 'Karachi', lat: 24.8607, lng: 67.0011, description: 'Largest city & major port' },
  { name: 'Lahore', lat: 31.5204, lng: 74.3587, description: 'Cultural hub of Punjab' },
  { name: 'Faisalabad', lat: 31.4504, lng: 73.1350, description: 'Industrial & textile center' },
  { name: 'Peshawar', lat: 34.0151, lng: 71.5249, description: 'Capital of KP, historic gateway' },
  { name: 'Quetta', lat: 30.1798, lng: 66.9750, description: 'Capital of Balochistan' },
  { name: 'Multan', lat: 30.1575, lng: 71.5249, description: 'Historic city of Punjab' },
  { name: 'Hyderabad', lat: 25.3960, lng: 68.3578, description: 'Major hub in southern Sindh' },
  { name: 'Gwadar', lat: 25.1216, lng: 62.3254, description: 'Deep sea port, Balochistan coast' },
  { name: 'Gilgit', lat: 35.9208, lng: 74.3089, description: 'Capital hub of Gilgit-Baltistan' },
  { name: 'Muzaffarabad', lat: 34.3700, lng: 73.4708, description: 'Capital of Azad Jammu & Kashmir' }
];
