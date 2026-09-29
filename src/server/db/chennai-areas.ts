// Chennai localities for the job form's Area picker (Greater Chennai Corporation plus the
// OMR / ECR, GST Road, western and northern suburbs the business serves).
// Seeded with ON CONFLICT DO NOTHING (case-insensitive), so re-seeding never duplicates or
// overwrites admin edits. The Master can add, rename or merge areas later (Phase 5).
// [ASSUMPTION] Common spellings; alternates (e.g. "RA Puram") are handled by the merge tool.

export const CHENNAI_AREAS: readonly string[] = [
  // South Chennai / Adyar belt (home base: Thiruvanmiyur)
  'Thiruvanmiyur', 'Adyar', 'Besant Nagar', 'Indira Nagar', 'Kasturba Nagar', 'Gandhi Nagar',
  'Shastri Nagar', 'Kotturpuram', 'Taramani', 'Velachery', 'Guindy', 'Saidapet', 'West Saidapet',
  'Nandanam', 'CIT Nagar', 'Teynampet', 'Alwarpet', 'RA Puram', 'Abhiramapuram', 'Mandaveli',
  'Mylapore', 'Santhome', 'Foreshore Estate', 'MRC Nagar', 'Royapettah', 'Gopalapuram',

  // ECR
  'Kottivakkam', 'Palavakkam', 'Neelankarai', 'Injambakkam', 'Akkarai', 'Uthandi', 'Muttukadu', 'Kovalam',

  // OMR / IT corridor
  'Kandanchavadi', 'Perungudi', 'Thoraipakkam', 'Okkiyam Thoraipakkam', 'Karapakkam', 'Sholinganallur',
  'Semmancheri', 'Navalur', 'Thazhambur', 'Egattur', 'Padur', 'Kelambakkam', 'Siruseri', 'Kazhipattur',
  'Perumbakkam', 'Nookampalayam', 'Ottiyambakkam',

  // Velachery – Medavakkam – Pallikaranai
  'Pallikaranai', 'Madipakkam', 'Jalladianpet', 'Medavakkam', 'Kovilanchery', 'Sithalapakkam',
  'Santhosapuram', 'Vengaivasal', 'Gowrivakkam', 'Rajakilpakkam', 'Madambakkam', 'Sembakkam',
  'Keelkattalai', 'Kovilambakkam', 'Ullagaram', 'Puzhuthivakkam', 'Nanganallur', 'Pazhavanthangal',
  'Adambakkam', 'Alandur', 'St Thomas Mount', 'Meenambakkam', 'Tirusulam', 'Moovarasampet',

  // GST Road
  'Pallavaram', 'Old Pallavaram', 'Zamin Pallavaram', 'Chromepet', 'Hasthinapuram', 'Nemilichery',
  'Pammal', 'Anakaputhur', 'Pozhichalur', 'Thiruneermalai', 'Tambaram', 'East Tambaram',
  'West Tambaram', 'Tambaram Sanatorium', 'Selaiyur', 'Camp Road', 'Chitlapakkam', 'Perungalathur',
  'Mudichur', 'Vandalur', 'Urapakkam', 'Guduvanchery', 'Potheri', 'Kattankulathur', 'Maraimalai Nagar',

  // Central Chennai
  'T Nagar', 'West Mambalam', 'Kodambakkam', 'Ashok Nagar', 'KK Nagar', 'MGR Nagar', 'Jafferkhanpet',
  'Ekkattuthangal', 'Vadapalani', 'Saligramam', 'Virugambakkam', 'Nungambakkam', 'Thousand Lights',
  'Triplicane', 'Chepauk', 'Chintadripet', 'Pudupet', 'Egmore', 'Chetpet', 'Kilpauk', 'Kilpauk Garden',
  'Aminjikarai', 'Shenoy Nagar', 'Choolaimedu', 'Mehta Nagar', 'Periamet', 'Vepery', 'Purasawalkam',
  'Choolai', 'Park Town', 'George Town', 'Parrys', 'Sowcarpet', 'Broadway', 'Mannady', 'Royapuram',

  // West Chennai
  'Anna Nagar', 'Anna Nagar East', 'Anna Nagar West', 'Anna Nagar West Extension', 'Thirumangalam',
  'Arumbakkam', 'Koyambedu', 'Nerkundram', 'Maduravoyal', 'Vanagaram', 'Alapakkam', 'Valasaravakkam',
  'Alwarthirunagar', 'Ramapuram', 'Nesapakkam', 'Kolapakkam', 'Manapakkam', 'Mugalivakkam',
  'Porur', 'Gerugambakkam', 'Iyyappanthangal', 'Kattupakkam', 'Karambakkam', 'Mangadu', 'Kundrathur',
  'Thiruverkadu', 'Poonamallee', 'Nolambur', 'Mogappair', 'Mogappair East', 'Mogappair West',
  'Padi', 'Korattur', 'Ambattur', 'Pattaravakkam', 'Kallikuppam', 'Ayapakkam', 'Athipattu',
  'Thirumullaivoyal', 'Avadi', 'Pattabiram', 'Paruthipattu', 'Villivakkam', 'Nandambakkam',

  // North Chennai
  'Perambur', 'Ayanavaram', 'Otteri', 'Kosapet', 'Pattalam', 'Pulianthope', 'Basin Bridge',
  'Vyasarpadi', 'MKB Nagar', 'Sembiam', 'Thiru Vi Ka Nagar', 'Periyar Nagar', 'Jawahar Nagar',
  'Peravallur', 'Agaram', 'Kolathur', 'Retteri', 'Lakshmipuram', 'Madhavaram', 'Madhavaram Milk Colony',
  'Moolakadai', 'Kodungaiyur', 'Korukkupet', 'Washermanpet', 'Old Washermanpet', 'Tondiarpet',
  'Tiruvottiyur', 'Kaladipet', 'Ernavur', 'Ennore', 'Kathivakkam', 'Manali', 'Manali New Town',
  'Mathur', 'Puzhal', 'Surapet', 'Red Hills',
];
