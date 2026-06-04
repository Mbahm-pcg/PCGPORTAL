// PCG Portal — Cost Lookup (shared)
// Single source of truth for per-menu-item unit cost ($/unit).
// Extracted from food-cost.js so both the Food Cost view and the P&L
// compute path resolve item costs identically.

// ── Beverage cost catalog — sourced from POS sales analysis report (Jun 2026) ──
// Key = exact item name from Pulse POS. Value = cost to make per unit ($).
const BEVERAGE_COSTS = {
  // BR Beverage Sales — Blast
  "Cappy Blast Large Caramel":2.28,"Cappy Blast Large Mocha":2.13,"Cappy Blast Large Oreo":2.15,"Cappy Blast Large Original":2.15,
  "Cappy Blast Medium Caramel":1.73,"Cappy Blast Medium Chocolate Fudge":1.83,"Cappy Blast Medium Custom":1.65,"Cappy Blast Medium Original":1.65,
  "Cappy Blast Small Caramel":1.15,"Cappy Blast Small Original":1.12,
  // BR Beverage Sales — Shakes
  "BR Shake Large":3.33,"BR Shake Medium":2.50,"BR Shake Small":1.68,
  "Dubai Chocolate Shake Large":3.50,"Dubai Chocolate Shake Medium":2.62,"Dubai Chocolate Shake Small":1.79,
  // BR Beverage Sales — Smoothies
  "Lava Colada Small":1.46,
  "Smoothie Mango Large":2.28,"Smoothie Mango Medium":1.71,"Smoothie Mango Small":1.16,
  "Smoothie Strawberry Large":2.37,"Smoothie Strawberry Medium":1.78,"Smoothie Strawberry Small":1.20,
  // DD — Coolatta
  "Coolatta Large Blue Raspberry":0.63,"Coolatta Large Oreo":1.20,"Coolatta Large Strawberry":0.87,"Coolatta Large Vanilla Bean":1.21,
  "Coolatta Medium Blue Raspberry":0.48,"Coolatta Medium Oreo":0.88,"Coolatta Medium Strawberry":0.65,"Coolatta Medium Vanilla Bean":0.96,
  "Coolatta Small Blue Raspberry":0.33,"Coolatta Small Oreo":0.60,"Coolatta Small Strawberry":0.44,"Coolatta Small Vanilla Bean":0.63,
  "Frozen Lemonade Medium Original":0.85,
  // DD — Cooler (bottled/canned)
  "DD 20oz Smartwater":0.45,"DD Apple Juice":1.40,"DD Aquafina":0.44,"DD Bottle Water":0.44,"DD Bottled Water":0.44,
  "DD Bottled Iced Coffee French Vanilla":2.04,"DD Coke":1.15,"DD Diet Pepsi":1.20,"DD Dole Lemonade":1.19,
  "DD Fruit Punch Powerade":1.08,"DD Gatorade Cool Blue":1.22,"DD Gatorade Lemon Lime":1.18,"DD Gatorade Zero Sugar Glacier Cherry":0.75,
  "DD Milk 14oz 1% Chocolate":0.04,"DD Milk 14oz 1% White":0.63,"DD Milk 14oz 2% White**":0.04,"DD Milk 14oz Chocolate":0.74,
  "DD Milk 14oz Strawberry":0.05,"DD Milk 14oz Whole White":0.89,"DD Milk 16oz Whole Chocolate*":0.05,"DD Milk 16oz Whole Chocolate**":1.32,
  "DD Milk 16oz Whole White":0.05,"DD Minute Maid Cranberry Apple":1.36,"DD Minute Maid Grapefruit":1.36,
  "DD Monster Energy":2.00,"DD Mountain Dew":1.16,"DD Nesquick Chocolate":1.31,"DD Ocean Spray Cranberry":2.38,
  "DD Orange Fanta":1.16,"DD Pepsi":1.20,"DD Pepsi Zero Sugar":1.19,"DD Rockstar":2.35,
  "DD Simply Cranberry":1.36,"DD Simply Lemonade":1.36,"DD Simply Orange Mango":1.36,
  "DD Starry Lemon Lime":1.20,"DD Tropicana Apple Juice":0.97,"DD Tropicana Orange Juice":1.33,
  "DD Vitamin Water XXX":1.07,"Hiland Dutch Chocolate Milk":1.32,"Hiland Whole Milk":0.05,
  "Naked Green Machine Smoothie":0.50,"Nesquick Low Fat Choc":1.31,"Sparkling Orange Celsius":2.19,
  // DD — Frozen Winter
  "Coffee Chiller Large":1.51,"Coffee Chiller Medium":1.12,"Coffee Chiller Small":0.76,
  "Frozen Caramel Creme Coffee Large":1.80,"Frozen Caramel Creme Coffee Medium":1.37,"Frozen Caramel Creme Coffee Small":1.01,
  "Frozen Chai Medium":0.97,"Frozen Chai Small":0.71,
  "Frozen Chocolate Banana Large":1.33,"Frozen Chocolate Banana Medium":0.86,"Frozen Chocolate Banana Small":0.67,
  "Frozen Chocolate Strawberry Small":0.83,"Frozen Cookie Dough Coffee Small":0.88,
  "Frozen Hot Chocolate Large Original":1.35,"Frozen Hot Chocolate Medium Original":1.03,"Frozen Hot Chocolate Small Original":0.75,
  "Frozen Matcha Latte Large":1.47,"Frozen Matcha Latte Medium":1.07,"Frozen Matcha Latte Small":0.72,
  "Frozen Triple Mocha Coffee Large":1.76,"Frozen Triple Mocha Coffee Medium":1.36,"Frozen Triple Mocha Coffee Small":1.00,
  "Iced Matcha Latte Large":1.31,"Iced Matcha Latte Medium":1.05,"Iced Matcha Latte Small":0.79,
  "Oreo & PB Coffee Chiller Large":2.03,"Oreo Coffee Chiller Large":2.08,"Oreo Coffee Chiller Medium":1.61,"Oreo Coffee Chiller Small":1.17,
  // DD — Hot Coffee
  "Hot 1/2 Original 1/2 Decaf Large":0.61,"Hot 1/2 Original 1/2 Decaf Small":0.33,"Hot 1/2 Original 1/2 Decaf XLarge":0.72,"Hot 1/2 Original 1/2 Medium Decaf":0.48,
  "Hot Coffee Box O Joe Decaf":6.95,"Hot Coffee Box O Joe Dunkin Midnight":7.62,"Hot Coffee Box O Joe Original":6.71,
  "Hot Coffee Large Decaf":0.63,"Hot Coffee Large Dunkin Midnight":0.77,"Hot Coffee Large Original Blend":0.66,
  "Hot Coffee Medium Decaf":0.49,"Hot Coffee Medium Dunkin Midnight":0.45,"Hot Coffee Medium Original Blend":0.54,
  "Hot Coffee Small Decaf":0.37,"Hot Coffee Small Dunkin Midnight":0.30,"Hot Coffee Small Original Blend":0.38,
  "Hot Coffee X-Large Dunkin Midnight":0.58,"Hot Coffee XLarge Decaf":0.72,"Hot Coffee XLarge Original Blend":0.76,
  // DD — Hot Espresso
  "Decaf Espresso Shot (Added to bev)":0.14,"Double Decaf Espresso":0.35,"Double Espresso":0.64,"Espresso Shot (added to a bev)":0.14,"Single Espresso":0.26,"Triple Espresso":0.91,
  "Hot Americano Large Decaf":0.61,"Hot Americano Large Original":0.55,"Hot Americano Medium Decaf":0.50,"Hot Americano Medium Original":0.47,"Hot Americano Small Decaf":0.47,"Hot Americano Small Original":0.38,
  "Hot Cappuccino Large Decaf":0.77,"Hot Cappuccino Large Original":0.78,"Hot Cappuccino Medium Decaf":0.64,"Hot Cappuccino Medium Original":0.60,"Hot Cappuccino Small Decaf":0.50,"Hot Cappuccino Small Original":0.45,
  "Hot Large Decaf Cocoa Mocha Signature Latte":1.88,"Hot Large Original Caramel Craze Signature Latte":1.61,"Hot Large Original Cocoa Mocha Signature Latte":1.73,"Hot Large Original Dunkalatte":1.65,
  "Hot Large Protein Decaf Latte":0.56,"Hot Large Protein Latte":0.57,
  "Hot Latte Large Decaf":1.17,"Hot Latte Large Original":1.02,"Hot Latte Medium Decaf":0.83,"Hot Latte Medium Original":0.78,"Hot Latte Small Decaf":0.60,"Hot Latte Small Original":0.57,
  "Hot Macchiato Large Original":1.06,"Hot Macchiato Medium Decaf":0.81,"Hot Macchiato Medium Original":0.87,"Hot Macchiato Small Decaf":0.76,"Hot Macchiato Small Original":0.68,
  "Hot Medium Banana Protein Latte":0.49,"Hot Medium Decaf Cocoa Mocha Signature Latte":1.30,"Hot Medium Decaf Dunkalatte":1.20,"Hot Medium Org Toasted White Choc Signature":1.57,
  "Hot Medium Original Caramel Craze Signature Latte":1.29,"Hot Medium Original Cocoa Mocha Signature Latte":1.13,"Hot Medium Original Dunkalatte":1.21,
  "Hot Medium Protein Latte":0.44,"Hot Medium Sugar Free Vanilla Protein Latte":0.58,
  "Hot Small Decaf Dunkalatte":0.96,"Hot Small Original Caramel Craze Signature Latte":0.99,"Hot Small Original Cocoa Mocha Signature Latte":0.96,"Hot Small Original Dunkalatte":0.87,
  "Hot Small Protein Latte":0.44,"Hot Small Sugar Free Vanilla Protein Decaf Latte":0.47,"Hot Small Sugar Free Vanilla Protein Latte":0.41,
  "Iced Medium Decaf Dunkalatte":1.24,"Iced Medium Original Dunkalatte":1.17,
  // DD — Hot Tea
  "Hot Chai Latte Large":1.58,"Hot Chai Latte Medium":1.32,"Hot Chai Latte Small":0.97,
  "Hot Tea Large Bold Breakfast Blend":0.65,"Hot Tea Large Chamomile Fiels Herbal Infusion":0.62,"Hot Tea Large Cool Mint":0.57,"Hot Tea Large Decaf":0.68,"Hot Tea Large Harmony Leaf Green":0.58,"Hot Tea Large Hibiscus Kiss Herbal":0.58,
  "Hot Tea Medium Bold Breakfast Blend":0.42,"Hot Tea Medium Chamomile Fiels Herbal Infusion":0.39,"Hot Tea Medium Cool Mint Herbal Infusion":0.36,"Hot Tea Medium Decaf":0.43,"Hot Tea Medium Harmony Leaf Green":0.36,"Hot Tea Medium Hibiscus Herbal Tea":0.35,
  "Hot Tea Small Bold Breakfast Black":0.37,"Hot Tea Small Chamomile Field Herbal Infusion":0.36,"Hot Tea Small Cool Mint Herbal Infusion":0.33,"Hot Tea Small Decaf":0.37,"Hot Tea Small Harmony Leaf Green":0.33,"Hot Tea Small Hibiscus Kiss Herbal":0.33,
  "Hot Tea XLarge Bold Breakfast Blend":0.73,"Hot Tea XLarge Chamomile Fiels Herbal Infusion":0.70,"Hot Tea XLarge Cool Mint Herbal Infusion":0.63,"Hot Tea XLarge Decaf":0.75,"Hot Tea XLarge Harmony Leaf Green":0.62,"Hot Tea XLarge Hibiscus Herbal Tea":0.59,
  // DD — Hot Winter
  "Box Joe Hot Chocolate Original":5.45,"Hot Chocolate Large Original":0.61,"Hot Chocolate Medium Original":0.47,"Hot Chocolate Small Original":0.33,"Hot Chocolate XLarge Original":0.72,
  // DD — Iced Coffee
  "Caramel Cold Foam Cold Brew Large":1.56,"Caramel Cold Foam Cold Brew Medium":1.45,"Caramel Cold Foam Cold Brew Small":1.05,
  "Cold Brew Large":0.90,"Cold Brew Medium":0.73,"Cold Brew Small":0.49,"Cookie Butter Cold Brew Large":1.66,
  "Iced 1/2 Original 1/2 Decaf Large":0.74,"Iced 1/2 Original 1/2 Medium Decaf":0.62,"Iced 1/2 Original 1/2 Small Decaf":0.44,
  "Iced Coffee Bucket":0.78,"Iced Coffee Large Decaf":0.78,"Iced Coffee Large Original Blend":0.83,
  "Iced Coffee Medium Banana Creme":0.58,"Iced Coffee Medium Cookie Cravings":0.58,"Iced Coffee Medium Decaf":0.63,"Iced Coffee Medium Original Blend":0.68,
  "Iced Coffee Small Decaf":0.45,"Iced Coffee Small Original Blend":0.48,"Iced Coffee X-Large Original Blend":0.91,
  "Vanilla Creme Cold Brew Large":1.60,"Vanilla Creme Cold Brew Medium":1.23,"Vanilla Creme Cold Brew Small":0.81,
  // DD — Iced Espresso
  "Iced Americano Large Decaf":0.53,"Iced Americano Large Original":0.47,"Iced Americano Medium Decaf":0.48,"Iced Americano Medium Original":0.35,"Iced Americano Small Decaf":0.32,"Iced Americano Small Original":0.24,
  "Iced Cappuccino Large Decaf":1.02,"Iced Cappuccino Large Original":1.00,"Iced Cappuccino Medium Decaf":0.78,"Iced Cappuccino Medium Original":0.70,"Iced Cappuccino Small Decaf":0.52,"Iced Cappuccino Small Original":0.53,
  "Iced Dunkalatte Large Hazelnut Cloud":1.63,"Iced Dunkalatte Large Marshmallow Cloud":1.61,"Iced Dunkalatte Large Nutty Marshmallow Cloud":1.64,
  "Iced Dunkalatte Med Nutty Marshmallow Cloud":1.39,"Iced Dunkalatte Medium Hazelnut Cloud":1.17,"Iced Dunkalatte Medium Hazelnut Cloud Decaf":1.14,"Iced Dunkalatte Medium Marshmallow Cloud":1.17,
  "Iced Dunkalatte Medium Marshmallow Cloud Decaf":1.16,"Iced Dunkalatte Medium Nutty Banana Cloud":1.15,"Iced Dunkalatte Medium Nutty Marshmallow Cloud":1.19,
  "Iced Dunkalatte Small Hazelnut Cloud":0.83,"Iced Dunkalatte Small Marshmallow Cloud":0.83,"Iced Dunkalatte Small Marshmallow Cloud Decaf":0.81,"Iced Dunkalatte Small Nutty Banana Cloud":0.79,"Iced Dunkalatte Small Nutty Marshmallow Cloud":0.83,
  "Iced LG Orig Toasted White Choc Signature Latte":1.68,"Iced MD Orig Toasted White Choc Signature Latte":1.46,
  "Iced Large Almond Protein Matcha Latte":0.63,"Iced Large Banana Protein Latte":0.62,"Iced Large Caramel Chocolate Protein Latte":0.66,
  "Iced Large Decaf Caramel Craze Signature Latte":1.71,"Iced Large Decaf Cocoa Mocha Signature Latte":1.70,"Iced Large Decaf Dunkalatte":1.77,
  "Iced Large Original Caramel Craze Signature Latte":1.68,"Iced Large Original Cocoa Mocha Signature Latte":1.65,"Iced Large Original Dunkalatte":1.61,
  "Iced Large Protein Decaf Latte":0.89,"Iced Large Protein Latte":0.57,"Iced Large Protein Matcha Latte":0.70,"Iced Large Sugar Free Vanilla Protein Latte":0.78,
  "Iced Latte Large Banana Puddin Cloud":1.26,"Iced Latte Large Banana Puddin Cloud Decaf":1.38,"Iced Latte Large Decaf":1.25,"Iced Latte Large Monkey Business Cloud":1.32,
  "Iced Latte Large Oreo Cloud":1.73,"Iced Latte Large Oreo Cloud Decaf":1.73,"Iced Latte Large Original":1.11,"Iced Latte Large Rocky Road Cloud":1.36,"Iced Latte Large Rocky Road Cloud Decaf":1.44,
  "Iced Latte Medium Banana Puddin Cloud":0.99,"Iced Latte Medium Banana Puddin Cloud Decaf":0.96,"Iced Latte Medium Cocoa Cloud":1.38,"Iced Latte Medium Cookie Butter Cloud Regular":1.26,
  "Iced Latte Medium Decaf":0.88,"Iced Latte Medium Monkey Business Cloud":1.00,"Iced Latte Medium Oreo Cloud":1.28,"Iced Latte Medium Oreo Cloud Decaf":1.32,"Iced Latte Medium Original":0.83,
  "Iced Latte Medium Rocky Road Cloud":1.03,"Iced Latte Medium Rocky Road Cloud Decaf":1.06,
  "Iced Latte Small Banana Puddin Cloud":0.77,"Iced Latte Small Decaf":0.66,"Iced Latte Small Monkey Business Cloud":0.77,
  "Iced Latte Small Oreo Cloud":1.05,"Iced Latte Small Oreo Cloud Decaf":1.08,"Iced Latte Small Original":0.62,"Iced Latte Small Rocky Road Cloud":0.78,"Iced Latte Small Rocky Road Cloud Decaf":0.80,
  "Iced Macchiato Large Decaf":0.99,"Iced Macchiato Large Original":0.99,"Iced Macchiato Medium Decaf":0.81,"Iced Macchiato Medium Original":0.73,"Iced Macchiato Small Decaf":0.61,"Iced Macchiato Small Original":0.54,
  "Iced Medium Almond Protein Matcha Latte":0.49,"Iced Medium Banana Protein Latte":0.43,"Iced Medium Caramel Chocolate Protein Latte":0.42,
  "Iced Medium Decaf Caramel Craze Signature Latte":1.33,"Iced Medium Decaf Cocoa Mocha Signature Latte":1.34,"Iced Medium Nutty Toffee Protein Latte":0.51,
  "Iced Medium Original Caramel Craze Signature":1.29,"Iced Medium Original Cocoa Mocha Signature Latte":1.28,"Iced Medium Original Pumpkin Spice Signature":1.48,
  "Iced Medium Protein Decaf Latte":0.39,"Iced Medium Protein Latte":0.38,"Iced Medium Protein Matcha Latte":0.52,
  "Iced Medium Sugar Free Vanilla Protein Decaf Latte":0.56,"Iced Medium Sugar Free Vanilla Protein Latte":0.57,
  "Iced Small Almond Protein Matcha Latte":0.32,"Iced Small Decaf Caramel Craze Signature Latte":1.09,"Iced Small Decaf Cocoa Mocha Signature Latte":1.09,"Iced Small Decaf Dunkalatte":0.84,
  "Iced Small Original Caramel Craze Signature Latte":1.00,"Iced Small Original Cocoa Mocha Signature Latte":0.99,"Iced Small Original Dunkalatte":0.81,
  "Iced Small Banana Protein Latte":0.34,"Iced Small Protein Decaf Latte":0.33,"Iced Small Protein Latte":0.28,"Iced Small Protein Matcha Latte":0.42,
  "Iced Small Sugar Free Vanilla Protein Decaf Latte":0.41,"Iced Small Sugar Free Vanilla Protein Latte":0.42,
  "Large Iced Brown Sugar Shakin Espresso":1.51,"Large Iced Decaf Brown Sugar Shakin Espresso":1.75,"Large Iced Decaf Shakin Espresso":0.28,"Large Iced Shakin Espresso":0.31,
  "Medium Iced Banana Shakin Espresso":1.17,"Medium Iced Brown Sugar Shakin Espresso":1.07,"Medium Iced Caramel Chocolate Shakin Espresso":0.98,
  "Medium Iced Decaf Brown Sugar Shakin Espresso":1.18,"Medium Iced Decaf Shakin Espresso":0.39,"Medium Iced Shakin Espresso":0.32,
  "Small Iced Banana Shakin Espresso":0.98,"Small Iced Brown Sugar Shakin Espresso":0.78,"Small Iced Decaf Brown Sugar Shakin Espresso":0.86,"Small Iced Shakin Espresso":0.26,
  // DD — Iced Tea & Refreshers
  "Bucket Refresher":0.39,"Iced Chai Latte Large":1.60,"Iced Chai Latte Medium":1.26,"Iced Chai Latte Small":0.92,
  "Iced Tea Large Black":0.16,"Iced Tea Large Green Tea":0.17,"Iced Tea Large Green Tea Lemonade":0.45,"Iced Tea Large Lemonade":0.41,"Iced Tea Large Sweet Tea":0.30,"Iced Tea Large Sweet Tea Lemonade":0.54,"Iced Tea Large Sweetened Green Tea":0.30,"Iced Tea Large Sweetened Tea":0.34,
  "Iced Tea Med Lemonade":0.29,"Iced Tea Med Sweet Tea":0.22,"Iced Tea Med Sweet Tea Lemonade":0.43,"Iced Tea Med Sweetened Green Tea":0.25,"Iced Tea Med Sweetened Tea":0.25,
  "Iced Tea Medium Black":0.12,"Iced Tea Medium Green Tea":0.13,"Iced Tea Medium Green Tea Lemonade":0.29,
  "Iced Tea Small Black":0.10,"Iced Tea Small Green Tea":0.11,"Iced Tea Small Green Tea Lemonade":0.22,"Iced Tea Small Lemonade":0.21,"Iced Tea Small Sweet Tea":0.16,"Iced Tea Small Sweet Tea Lemonade":0.28,"Iced Tea Small Sweetened Green Tea":0.18,"Iced Tea Small Sweetened Tea":0.20,
  "Large Berry Acai Refresher":0.66,"Large Berry Moonlight Dream Refresher":1.44,"Large Black Cherry Refresher":0.84,"Large Build Your Own Dream Refresher":1.13,
  "Large Mango Pineapple Dunkin Refresher":0.67,"Large Mixology Dream Refresher":1.08,"Large Mixology Dunkin Refresher":0.53,"Large Pink Pineapple Refresher":0.65,
  "Large Strawberry Dragonfruit Dunkin Refresher":0.64,"Large Very Cherry Dream Refresher":1.18,"Large Wicked Pink Refresher":0.63,
  "Medium Berry Acai Refresher":0.49,"Medium Berry Blue Lemonade Refresher":0.57,"Medium Berry Moonlight Dream Refresher?":1.15,"Medium Black Cherry Refresher":0.76,"Medium Build Your Own Dream Refresher?":1.10,
  "Medium Heart Eyes Dream Refresher":1.52,"Medium Mango Pineapple Dunkin Refresher":0.49,"Medium Mixology Dream Refresher?":1.04,"Medium Mixology Dunkin Refresher":0.51,"Medium Pink Pineapple Refresher":0.50,
  "Medium Strawberry Dragonfruit Dunkin Refresher":0.50,"Medium Very Cherry Dream Refresher":1.14,
  "Small Berry Acai Refresher":0.34,"Small Berry Blue Lemonade Refresher":0.48,"Small Black Cherry Refresher":0.63,"Small Build Your Own Dream Refresher?":1.11,
  "Small Heart Eyes Dream Refresher":1.38,"Small Mango Pineapple Dunkin Refreshers":0.34,"Small Mixology Dream Refresher?":1.21,"Small Mixology Dunkin Refresher":0.49,
  "Small Pink Pineapple Refresher":0.34,"Small Strawberry Dragonfruit Dunkin Refresher":0.34,"Small Very Cherry Dream Refresher":1.12,
  // DD — M Beverage (modifiers/add-ons)
  "Lemonade Base Refresher":0.26,"Limeade Base Refresher Priced":0.24,"M-Banana Cold Foam":0.25,"M-Chocolate Cold Foam":0.20,
  "M-Coffee Milk":0.05,"M-Coffee Milk Espresso":0.52,"M-Cold Foam":0.17,"M-Protein Milk Coffee":0.04,"M-Protein Milk Espresso":0.68,
  "M-Strawberry Cold Foam":0.23,"M-Whipped Cream":0.13,"Protein Milk Base Refresher":0.68,"Sparkling Water Base Refresher":0.29,
  // DD — Other Hot (Matcha)
  "Hot Large Protein Matcha Latte":0.86,"Hot Matcha Latte Large":1.32,"Hot Matcha Latte Medium":1.05,"Hot Matcha Latte Small":0.85,
  "Hot Medium Protein Matcha Latte":0.80,"Hot Small Protein Matcha Latte":0.47,
  // DD — Other Iced
  "Cup For Pup":0.13,
  "Iced Bananarama Matcha Large":1.44,"Iced Bananarama Matcha Medium":1.13,"Iced Bananarama Matcha Small":0.87,
  "Iced Blueberry Pie Matcha Large":1.56,"Iced Blueberry Pie Matcha Medium":1.18,"Iced Blueberry Pie Matcha Small":0.91,
  "Iced Coconut Limeade Large":0.70,"Iced Coconut Limeade Medium":0.52,"Iced Coconut Limeade Small":0.37,
  "Iced Goin Nutty Matcha Large":1.19,"Iced Goin Nutty Matcha Medium":0.93,
  "Iced Limeade Large":0.61,"Iced Limeade Medium":0.45,"Iced Limeade Small":0.32,
  "Iced Matcha Limeade Large":1.15,"Iced Matcha Limeade Medium":0.86,"Iced Matcha Limeade Small":0.60,
  "Iced Oreo Matcha Large":1.71,"Iced Oreo Matcha Medium":1.30,"Iced Oreo Matcha Small":1.04,
  "Iced Raspberry Limeade Large":0.70,"Iced Raspberry Limeade Medium":0.52,"Iced Raspberry Limeade Small":0.37,
  "Iced Strawberry Cloud Matcha Medium":0.98,
  "Iced Vanilla Marshmallow Matcha Large":1.31,"Iced Vanilla Marshmallow Matcha Medium":1.03,"Iced Vanilla Marshmallow Matcha Small":0.77,
  "Iced Wicked Green Matcha Medium":1.04,
  "Large Blackberry Tangerine Dunkin Zero":1.74,"Large Blushpop Dunkin Zero":1.72,"Large Dirty Soda":1.68,"Large Juicy Peach Dunkin Zero":0.97,"Large Peachberry Dunkin Zero":1.01,"Large Sunzest Dunkin Zero":1.72,"Large Tropical Mango Dunkin Zero":1.73,
  "Lemonade Large Original":0.54,"Lemonade Medium Original":0.40,"Lemonade Small Original":0.28,
  "Medium Blackberry Tangerine Dunkin Zero":1.44,"Medium Blushpop Dunkin Zero":1.43,"Medium Dirty Soda":1.15,"Medium Juicy Peach Dunkin Zero":0.75,"Medium Peachberry Dunkin Zero":0.76,"Medium Sunzest Dunkin Zero":1.42,"Medium Tropical Mango Dunkin Zero":1.44,
  "Nitro Coffee SM":0.61,
  "Small Blackberry Tangerine Dunkin Zero":1.15,"Small Blushpop Dunkin Zero":1.15,"Small Dirty Soda":0.88,"Small Juicy Peach Dunkin Zero":0.54,"Small Peachberry Dunkin Zero":0.60,"Small Sunzest Dunkin Zero":1.14,"Small Tropical Mango Dunkin Zero":1.14,
};

// ── DD Food cost catalog — sourced from POS sales analysis report (Jun 2026) ──
const FOOD_COSTS = {
  // Bagels
  "Bagel":0.24,"Bagel w/ CC":0.44,"3 Bagels":1.00,"6 Bagels":2.15,"12 Bagels":4.12,
  // Breakfast Sandwiches
  "6pc Hash Brown":0.19,"Add 4 Seasoned Bacon":0.36,"Add 6pc Hash Brown":0.19,
  "Bacon & Cheddar Omelet Bites":1.69,"Bacon Egg & Cheese":0.96,"Bacon Egg & Cheese Wrap":0.43,
  "Bacon Jam Grilled Cheese":1.36,"Bacon Only":0.33,
  "Chipotle Hash Brown Wrap?":0.64,"Chipotle Loaded Hash Browns?":0.75,
  "Double Sausage Breakfast Sandwich":1.01,"Egg & Cheese":0.65,
  "Extra 2 Fried Eggs":0.53,"Extra Bacon":0.33,"Extra Fried Egg":0.27,"Extra Sausage":0.26,
  "Extra Sweet Black Pepper Bacon WUW":0.18,"Extra Turkey Sausage":0.41,"Fried Egg Only":0.27,
  "Fried Egg Wrap":0.40,"Golden BBQ Hash Brown Wrap?":0.65,"Golden BBQ Loaded Hash Browns?":0.78,
  "Grilled Cheese Sandwich":0.79,"Loaded Hash Browns":0.77,
  "M-Add Crumbled Bacon":0.23,"M-American Cheese":0.07,"M-American Cheese (Bread)":0.07,"M-American Cheese Mod":0.07,
  "M-Butter Spread w/ Canola Oil (Sandwich)":0.05,"M-Extra American Cheese WUW":0.07,
  "M-Extra Bacon WUW":0.16,"M-Extra Fried Egg WUW":0.13,"M-Extra Sausage WUW":0.13,
  "M-Extra Turkey Sausage WUW":0.21,"M-Extra White Cheddar Cheese":0.13,
  "Sausage & Cheese":0.66,"Sausage Egg & Cheese":0.90,"Sausage Egg & Cheese Wrap":0.46,"Sausage Only":0.26,
  "Seasoned Bacon Egg & Cheese Wrap":0.56,"Seasoned Bacon Sandwich":1.09,"Snacking Bacon":0.79,
  "Sourdough Bakery":0.10,"Sourdough Breakfast Sandwich":1.33,"Sweet Black Pepper Bacon As Is":0.36,
  "Tangy BBQ Sauce (Wraps Extras)":0.11,
  "Turkey Sausage Egg & Cheese Wrap":0.74,"Turkey Sausage Only":0.41,"Turkey Sausage Sandwich":1.04,
  "Ultimate Bacon Jam Breakfast Sandwich":1.31,
  // Condiments
  "Butter":0.06,"Butter Spread w/ Canola Oil":0.06,
  "M-Avocado Spread On Side":0.42,"M-Butter (Bread)":0.07,"M-Butter (Sandwich)":0.05,"M-Butter Spread w/ Canola Oil (Bread)":0.06,
  "M-Extra Avocado Spread Sand":0.42,"M-Extra Avocado Spread WUW":0.42,
  "M-Grape Jam":0.14,"M-Grape Jelly (Bread)":0.07,"M-Grape Jelly (Sandwich)":0.07,
  "M-Plain 8oz Cream Cheese":1.43,"M-Single Serve Avocado Spread":0.42,"M-Strawberry Jelly (Sandwich)":0.18,"Strawberry Jelly":0.18,
  // Cream Cheese
  "M-Plain 8oz CC (Bread)":1.41,"M-Plain 8oz CC (Spread)":1.43,
  "M-Plain Cream Cheese (Bread)":0.32,"M-Single Serve Plain Cream Cheese":0.32,
  "M-Single Serve Strawberry Cream Cheese":0.36,"M-Single Serve Veggie Cream Cheese":0.34,
  "M-Strawberry Cream Cheese (Bread)":0.36,"M-Veggie Cream Cheese (Bread)":0.34,
  // Donuts (multi-pack)
  "1 Donut":0.26,"1 Specialty Donut":0.26,"6 Donuts":1.75,"12 Donuts":3.43,"13 Donuts":3.69,
  // Fancy
  "F-Apple Fritter":0.40,"F-Variety, Apple Fritter\"":0.40,"F-Variety, Coffee Roll\"":0.40,"F-Variety, Frosted Coffee Roll\"":0.40,
  // Kosher
  "Grilled Cheese Bacon Sandwich":1.06,
  // Muffins (multi-pack)
  "1 Muffin":0.54,"4 Muffins":2.43,"6 Muffins":2.77,
  // Munchkins (multi-pack)
  "1 Munchkin":0.08,"3 Munchkins":0.23,"5 Munchkins":0.38,"10 Munchkins":0.75,"25 Munchkins":2.00,
  "50 Munchkins":3.92,"50 Count Munchkins Bucket":5.22,"50 Count Halloween Munchkins Bucket":4.85,
  "Wicked Munchkin Box 10 Count":0.75,"Valentine's Tin 25 Munchkin":1.88,
  // Modifiers
  "M-Strawberry Fruit Foam":0.05,
  // Other Bakery
  "6 Croissants":1.98,"Croissant Only":0.33,"English Muffin Only":0.23,
  // Wraps & Snacks
  "Avocado & Bacon Toast":1.03,"Avocado Toast":0.70,
  "Chicken Bacon Croissant Stuffer":1.58,"Everything Bagel Minis":0.55,
  "Ham & Swiss Croissant Stuffer":1.38,"Plain Bagel Minis":0.53,
};

// ── BR Ice Cream cost catalog — sourced from POS sales analysis report (Jun 2026) ──
const ICE_CREAM_COSTS = {
  // Cones & Cups
  "Dipped Waffle Bowl Extra":0.24,"Fancy Waffle Bowl w/Sprinkles Extra":0.24,"Fancy Waffle Cone w/Sprinkles Priced":0.24,
  "Sugar Cone Extra":0.11,"Waffle Cone Extra":0.24,"Waffle Cone Priced":0.24,
  // Hard Ice Cream Scoops
  "Single Scoop":0.67,"Double Scoop":1.34,"Triple Scoop":2.01,"Extra Scoop":0.67,
  "Kids Scoop":0.42,"Kids Double Scoop":0.95,
  // Cakes
  "Celebration 9\" Round Cake":11.20,"Chocolate Chip Cookie Crunch Cake in a Box":9.09,
  "Custom Cake in a Box":8.92,"Delivery - Full Roll Cake":13.37,
  "Dubai Chocolate Cake in a Box":9.09,"Mint Cookie Crunch Cake in a Box":8.84,
  // Polar Pizza
  "Choc Chip Cookie Dough Polar Pizza":8.36,"Cookies N Cream Polar Pizza":7.59,
  "Polar Pizza Custom":7.71,"Reeses Peanut Butter Choc Polar Pizza":8.02,
  // Soft Serve & Splits
  "Banana Split":1.80,
  // Layered Sundaes
  "Choc Chip Cookie Dough Layered Sundae":1.37,"Oreo Layered Sundae":1.37,"Reeses Layered Sundae":1.37,
  // Original Sundaes
  "1 Scoop Sundae":0.47,"2 Scoop Sundae":0.88,"3 Scoop Sundae":1.35,"Dubai Chocolate Sundae":1.64,
  // Splits & Royals
  "Banana Royale":1.10,"Brownie Sundae":1.91,
  // Take Home
  "Pint Fresh Pack":2.57,"Quart Fresh Pack":4.99,
  "Boxed Chocolate Chip Ice Cream Bar 4-pack":3.81,"Cotton Candy Bar 4 Pack":3.71,"Rainbow Sherbet Ice Cream Bar 4 pack":3.81,
  "PPQ Chocolate Chip Cookie Dough":3.40,
};

// ── DD Premium Sales cost catalog — retail coffee, K-cups, packaged teas, merchandise ──
const PREMIUM_COSTS = {
  // Retail Coffee (whole bean / ground)
  "1 LB Coffee Decaf":6.44,"1 LB Coffee Dunkin' Midnight":4.28,"1 LB Coffee French Vanilla":7.10,
  "1 LB Coffee Original":5.58,"1 LB Coffee Original Whole Bean":6.16,
  // K-Cups
  "K-Cup 12 Ct Decaf":4.99,"K-Cup 12 Ct Dunkin' Midnight":4.76,"K-Cup 12 Ct French Vanilla":4.97,"K-Cup 12 Ct Original":4.94,
  // Packaged Teas
  "Premium Packaged Tea Hibiscus Kiss Herbal":2.91,"Retail Tea Bold Breakfast Black":2.75,
  "Retail Tea Chamomile Fields Herbal Infusion":3.07,"Retail Tea Harmony Leaf Green":2.90,
  // Merchandise (mugs/tumblers — tracked but typically excluded from food cost %)
  "2022 Acrylic Hydration Bottle 27oz":10.00,"2025 Chiseled Acrylic Tumbler":4.58,
  "24oz Acrylic Tumbler With Bamboo Lid":5.00,
};

// ── POS name aliases — maps actual Pulse POS item names to costs ──────────────
// The WorkPulse report uses different names than the Pulse POS API returns.
// Key = exact string the POS API returns, Value = cost to make.
const POS_ALIASES = {
  // Coolatta — POS reverses "Coolatta X Y" to "X Y Coolatta"
  "Medium Vanilla Bean Coolatta":0.96,"Small Vanilla Bean Coolatta":0.63,"Large Vanilla Bean Coolatta":1.21,
  "Medium OREO Coolatta":0.88,"Small OREO Coolatta":0.60,"Large OREO Coolatta":1.20,
  "Medium Blue Raspberry Coolatta":0.48,"Small Blue Raspberry Coolatta":0.33,"Large Blue Raspberry Coolatta":0.63,
  "Medium Strawberry Coolatta":0.65,"Small Strawberry Coolatta":0.44,"Large Strawberry Coolatta":0.87,
  // Wraps — POS uses slightly different names
  "Fried Egg- Wrap":0.40,"Fried Egg Wrap":0.40,
  "Egg and Cheese Wrap":0.65,"Egg & Cheese Wrap":0.65,
  "Sausage Egg Cheese Wake Up Wrap":0.46,"Seasoned Bacon Wake Up Wrap":0.56,
  "Turkey Sausage Egg & Cheese Wrap":0.74,
  // Bottled — POS drops "DD " prefix
  "Tropicana Apple Juice":0.97,"Tropicana Pure Premium Orange Juice":1.33,
  "Tropicana Orange Juice":1.33,"Bottled Water":0.44,"Mountain Dew":1.16,"Pepsi":1.20,
  "Diet Pepsi":1.20,"Gatorade Cool Blue":1.22,"Gatorade Lemon Lime":1.18,
  "Apple Juice":1.40,"Ocean Spray Cranberry":2.38,"Simply Orange":4.90,
  // Modifier names POS uses
  "American Cheese":0.07,"Extra American Cheese WUW":0.07,"Extra White Cheddar Cheese":0.13,
  // Items in POS not in WorkPulse report
  "Cup of Water":0.00,"Sparkling Water Default":0.00,
  // Pumps, syrups, swirls = $0 cost (extra charge to customer, no ingredient COGS)
  "Vanilla Bean Coolatta Syrup":0.00,"Butter Pecan Swirl":0.00,
  "Add'l Swirl Charge":0.00,"Extra Pump":0.00,"Extra Swirl":0.00,
  // Donut multi-pack variant
  "Donuts, 10":2.91,"Donuts 10":2.91,
  // Fancy items — CSV uses "F-Variety, X"" format (with trailing quote)
  "F-Variety, Apple Fritter\"":0.40,"F-Variety, Apple Fritter":0.40,
  "F-Variety, Coffee Roll\"":0.40,"F-Variety, Coffee Roll":0.40,
  "F-Variety, Frosted Coffee Roll\"":0.40,"F-Variety, Frosted Coffee Roll":0.40,
  // Quote/apostrophe encoding variants
  "Celebration 9\" Round Cake":11.20,"Celebration 9 Round Cake":11.20,
  "Valentine's Tin 25 Munchkin":1.88,
  // Dunkin' Midnight apostrophe variants
  "1 LB Coffee Dunkin Midnight":4.28,"K-Cup 12 Ct Dunkin Midnight":4.76,
  "Hot Coffee Large Dunkin Midnight":0.77,"Hot Coffee Medium Dunkin Midnight":0.45,
  "Hot Coffee Small Dunkin Midnight":0.30,"Hot Coffee X-Large Dunkin Midnight":0.58,
  "Hot Coffee Box O Joe Dunkin Midnight":7.62,
};

// ── Ingredient costs per unit — sourced from WorkPulse export (Jun 2026)
// Codes match RI10xxx codes from the official PCG ingredient catalog
const INGREDIENT_COSTS = {
  donut:          0.2600, // RI10001
  munchkin:       0.0750, // RI10002
  fancy:          0.4000, // RI10003
  muffin:         0.3250, // RI10004
  bagel:          0.2500, // RI10005
  croissant:      0.2700, // RI10006
  english_muffin: 0.1800, // RI10007
  fritter:        0.5000, // RI10008
  bagel_twist:    0.6000, // RI10009
  ic_tub:         0.1670, // RI10010 (per oz)
  cake_sheet:     4.6000, // RI10011
  cake_round_9:   3.8500, // RI10013
  cake_roll:     12.4800, // RI10019
};

// ── POS name variations not covered by normalization ──────────────────────────
// Add here when the POS uses a genuinely different name (not just punctuation/prefix)
Object.assign(POS_ALIASES, {
  // Plural "Refreshers" → singular in catalog
  "Medium Strawberry Dragonfruit Dunkin Refreshers":0.50,
  "Large Strawberry Dragonfruit Dunkin Refreshers":0.64,
  "Small Strawberry Dragonfruit Dunkin Refreshers":0.34,
  // Alternative milk substitutes
  "Almond Milk 2025":0.50,"Oatmilk 2025":0.50,"Oat Milk 2025":0.50,
  "Almond Milk":0.50,"Oat Milk":0.50,"Oatmilk":0.50,
  "Coconut Milk":0.50,"Soy Milk":0.50,
  // Bottled items POS returns without "DD " prefix and with generic names
  "Whole Milk":0.05,"Chocolate Milk":0.74,"Strawberry Milk":0.05,
  "Pepsi default":1.20,"Mountain Dew default":1.16,"Soda default":0.00,
  "Starry":1.20,"Aquafina":0.44,
  // Cold beverage modifiers
  "Marshmallow Cold Foam":0.17,"Vanilla Cold Foam":0.17,"Caramel Cold Foam":0.17,
  "Pink Cold Foam":0.23,"Chocolate Cold Foam":0.20,"Banana Cold Foam":0.25,
  // New/seasonal Dunkin Zero flavors not in original report
  "Large Glamberry Dunkin Zero":1.73,"Medium Glamberry Dunkin Zero":1.44,"Small Glamberry Dunkin Zero":1.15,
  // "Dunkin" prefix variant for bottled water
  "Dunkin Bottled Water":0.44,"Dunkin Water":0.44,
  // Grape Jelly without (Bread)/(Sandwich) qualifier
  "Grape Jelly":0.07,
  // Cold foam/milk "Default" variants (cost should be tracked even if hidden from display)
  "Coffee Milk Default":0.05,"Coffee Milk Default 2025":0.05,
  "Cold Foam Default":0.17,"Cold Foam - Refreshers":0.17,
  "Chocolate Cold Foam Default":0.20,
  "Loaded Hash Browns Default":0.77,
  // Bare ingredient names (POS drops "Only"/"Extra" qualifier)
  "Bacon":0.33,"Bacon Default":0.33,"Bacon SOLD AS AN ITEM":0.33,"Bacon SW MEAT GROUP":0.33,
  "Sausage":0.26,"Sausage Default":0.26,"Sausage SOLD AS AN ITEM":0.26,
  "Turkey Sausage":0.41,"Turkey Sausage Default":0.41,"Turkey Sausage SOLD AS AN ITEM":0.41,
  "Fried Egg":0.27,"Fried Egg SOLD AS AN ITEM":0.27,
  "2 Fried Eggs":0.53,
  "White Cheddar Cheese":0.13,"Mod-White Cheddar Cheese":0.13,
  // "and" vs "&" — Ham and Swiss
  "Ham and Swiss Croissant Stuffer":1.38,"Ham and Swiss Croissant":1.38,
  // POS sandwich name variants
  "Turkey Sausage Egg & Cheese":1.04,
  "Turkey Sausage Egg and Cheese":1.04,
  "Grilled Cheese":0.79,
  "Grilled Bacon & Cheese Melt":1.36,
  "Grilled Bacon and Cheese Melt":1.36,
  // "Add'l" → "Adtl" abbreviation difference
  "Adtl Swirl Charge":0.00,
  // Whipped cream and water variants
  "M-Pink Whipped Cream":0.00,"Top-Whipped Cream Priced":0.00,
  "M-Cup Water":0.00,"Cup Water":0.00,
  // Espresso shot modifier — POS adds "when" which breaks word-sort
  "Espresso Shot (when added to a bev)":0.14,
  "Decaf Espresso Shot (when added to a bev)":0.14,
  // POS calls unsweetened black iced tea "Unsweet" instead of "Black"
  "Iced Tea Large Unsweet":0.16,"Iced Tea Medium Unsweet":0.12,"Iced Tea Small Unsweet":0.10,
  "Iced Tea Large Unsweetened":0.16,"Iced Tea Medium Unsweetened":0.12,"Iced Tea Small Unsweetened":0.10,
  // POS calls Unsweetened Green Tea (not "Sweetened" variant)
  "Iced Tea Large Unsweetened Green Tea":0.17,"Iced Tea Medium Unsweetened Green Tea":0.13,"Iced Tea Small Unsweetened Green Tea":0.11,
  "Iced Tea Large Unsweet Green Tea":0.17,"Iced Tea Medium Unsweet Green Tea":0.13,"Iced Tea Small Unsweet Green Tea":0.11,
  // Hot Tea — POS uses "Black" not "Blend" for Bold Breakfast (Large/Medium/XLarge)
  "Hot Tea Large Bold Breakfast Black":0.65,"Hot Tea Medium Bold Breakfast Black":0.42,"Hot Tea XLarge Bold Breakfast Black":0.73,
  "Hot Tea X-Large Bold Breakfast Black":0.73,"Hot Tea X-Large Bold Breakfast Blend":0.73,
  // Hibiscus — POS adds "Tea" at end: "Hibiscus Kiss Herbal Tea" vs our "Hibiscus Kiss Herbal"
  "Hot Tea Large Hibiscus Kiss Herbal Tea":0.58,"Hot Tea Medium Hibiscus Kiss Herbal Tea":0.35,
  "Hot Tea Small Hibiscus Kiss Herbal Tea":0.33,"Hot Tea XLarge Hibiscus Herbal Tea":0.59,
  "Hot Tea X-Large Hibiscus Herbal Tea":0.59,
  // Wake-Up Wrap variants (POS name for hash brown wraps)
  "Chipotle Hash Brown Wake-Up Wrap":0.64,"Chipotle Hash Brown Wake Up Wrap":0.64,
  "Golden BBQ Hash Brown Wake-Up Wrap":0.65,"Golden BBQ Hash Brown Wake Up Wrap":0.65,
  "Chipotle Aioli Loaded Hashbrowns":0.75,"Chipotle Aioli Hash Brown Wrap":0.64,
  // "Caramel Craze Signature" without "Latte"
  "Hot Large Original Caramel Craze Signature":1.61,"Hot Medium Original Caramel Craze Signature":1.29,
  "Hot Small Original Caramel Craze Signature":0.99,
  // "Daydream" variant — same product as "Build Your Own Dream Refresher"
  "Large Build Your Daydream Refresher":1.13,
  "Medium Build Your Daydream Refresher":1.10,
  "Small Build Your Daydream Refresher":1.11,
});

// ── Normalized lookup — built once at startup ─────────────────────────────────
// Strips punctuation + lowercases every catalog key, then indexes three ways:
//   1. as-is  2. without "DD " prefix  3. with "DD " prefix added
// This auto-matches: "Pepsi" ↔ "DD Pepsi", "Dunkin Midnight" ↔ "Dunkin' Midnight",
// "Fried Egg Wrap" ↔ "Fried Egg- Wrap", etc. No manual aliases needed for these.
// Normalize: remove hyphens first (xlarge = x-large), then strip other punctuation to spaces
const _norm = s => s.toLowerCase().replace(/-/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const NORM_LOOKUP = {};
for (const catalog of [BEVERAGE_COSTS, FOOD_COSTS, ICE_CREAM_COSTS, PREMIUM_COSTS, POS_ALIASES]) {
  for (const [key, val] of Object.entries(catalog)) {
    if (val === undefined || val === null) continue;
    const n = _norm(key);
    const nNoDd     = key.startsWith('DD ') ? _norm(key.slice(3)) : null;       // "DD Pepsi" → "pepsi"
    const nNoDunkin = key.startsWith('Dunkin ') ? _norm(key.slice(7)) : null;  // "Dunkin Bottled Water" → "bottled water"
    const nWithDd   = _norm('DD ' + key);                                       // "Pepsi" → "dd pepsi"
    const nNoM      = key.startsWith('M-') ? _norm(key.slice(2)) : null;        // "M-Grape Jelly" → "grape jelly"
    if (!(n in NORM_LOOKUP)) NORM_LOOKUP[n] = val;
    if (nNoDd     && !(nNoDd     in NORM_LOOKUP)) NORM_LOOKUP[nNoDd]     = val;
    if (nNoDunkin && !(nNoDunkin in NORM_LOOKUP)) NORM_LOOKUP[nNoDunkin] = val;
    if (             !(nWithDd   in NORM_LOOKUP)) NORM_LOOKUP[nWithDd]   = val;
    if (nNoM      && !(nNoM      in NORM_LOOKUP)) NORM_LOOKUP[nNoM]      = val;
  }
}

// Word-sorted lookup — handles word-order swaps (e.g. POS: "Iced Medium Original Latte" vs catalog: "Iced Latte Medium Original")
const _sortWords = s => _norm(s).split(' ').sort().join(' ');
const WORD_SORT_LOOKUP = {};
for (const catalog of [BEVERAGE_COSTS, FOOD_COSTS, ICE_CREAM_COSTS, PREMIUM_COSTS, POS_ALIASES]) {
  for (const [key, val] of Object.entries(catalog)) {
    if (val === undefined || val === null) continue;
    const ws         = _sortWords(key);
    const wsNoDd     = key.startsWith('DD ')     ? _sortWords(key.slice(3)) : null;
    const wsNoDunkin = key.startsWith('Dunkin ')  ? _sortWords(key.slice(7)) : null;
    const wsNoM      = key.startsWith('M-')       ? _sortWords(key.slice(2)) : null;
    if (!(ws         in WORD_SORT_LOOKUP)) WORD_SORT_LOOKUP[ws]         = val;
    if (wsNoDd     && !(wsNoDd     in WORD_SORT_LOOKUP)) WORD_SORT_LOOKUP[wsNoDd]     = val;
    if (wsNoDunkin && !(wsNoDunkin in WORD_SORT_LOOKUP)) WORD_SORT_LOOKUP[wsNoDunkin] = val;
    if (wsNoM      && !(wsNoM      in WORD_SORT_LOOKUP)) WORD_SORT_LOOKUP[wsNoM]      = val;
  }
}

/**
 * Resolve a Pulse menu-item name to a unit cost ($/unit).
 * Cascade: exact catalog → POS alias → normalized → word-sorted.
 * @param {string} itemName
 * @returns {number|undefined} unit cost, or undefined if unknown
 */
function lookupUnitCost(itemName) {
  if (!itemName) return undefined;
  return BEVERAGE_COSTS[itemName] ?? FOOD_COSTS[itemName] ?? ICE_CREAM_COSTS[itemName] ?? PREMIUM_COSTS[itemName]
    ?? POS_ALIASES[itemName]
    ?? NORM_LOOKUP[_norm(itemName)]
    ?? WORD_SORT_LOOKUP[_sortWords(itemName)];
}

module.exports = {
  lookupUnitCost,
  BEVERAGE_COSTS, FOOD_COSTS, ICE_CREAM_COSTS, PREMIUM_COSTS,
  POS_ALIASES, INGREDIENT_COSTS, NORM_LOOKUP, WORD_SORT_LOOKUP,
  _norm, _sortWords,
};
