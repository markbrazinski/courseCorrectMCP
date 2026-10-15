// HOLDOUT h01, the live reading of its chosen recipe (2026-10-13, build 5540cd0): Fish Chowder from Fannie Farmer (1911, public
// domain), as Nova read it after the cook chose it from the page. It split the wrapped choice "6 cups potatoes cut in 1/4-inch
// slices, or 4 cups potatoes cut in 3/4-inch cubes" into four ingredients: the regression case for either/or lines.
export const H01_FISH_CHOWDER_READING = {
 "recipeFound": true,
 "recipes": [
  {
   "title": "Fish Chowder",
   "titleLineId": "p1.o10"
  }
 ],
 "yield": null,
 "ingredients": [
  {
   "key": "i1",
   "line": "4 lb. cod or haddock",
   "name": "cod or haddock",
   "amountText": "4 lb.",
   "kind": null
  },
  {
   "key": "i2",
   "line": "6 cups potatoes cut in 1/4-inch",
   "name": "potatoes",
   "amountText": "6 cups",
   "kind": null
  },
  {
   "key": "i3",
   "line": "slices, or",
   "name": "slices",
   "amountText": null,
   "kind": null
  },
  {
   "key": "i4",
   "line": "4 cups potatoes cut in",
   "name": "potatoes",
   "amountText": "4 cups",
   "kind": null
  },
  {
   "key": "i5",
   "line": "3/4-inch cubes",
   "name": "cubes",
   "amountText": "3/4-inch",
   "kind": null
  },
  {
   "key": "i6",
   "line": "1 sliced onion",
   "name": "onion",
   "amountText": "1",
   "kind": "onion"
  },
  {
   "key": "i7",
   "line": "1½-inch cube fat salt pork",
   "name": "fat salt pork",
   "amountText": "1½-inch cube",
   "kind": null
  },
  {
   "key": "i8",
   "line": "1 tablespoon salt",
   "name": "salt",
   "amountText": "1 tablespoon",
   "kind": "salt"
  },
  {
   "key": "i9",
   "line": "1/8 teaspoon pepper",
   "name": "pepper",
   "amountText": "1/8 teaspoon",
   "kind": null
  },
  {
   "key": "i10",
   "line": "3 tablespoons butter",
   "name": "butter",
   "amountText": "3 tablespoons",
   "kind": "unsalted-butter"
  },
  {
   "key": "i11",
   "line": "4 cups scalded milk",
   "name": "milk",
   "amountText": "4 cups",
   "kind": "whole-milk"
  },
  {
   "key": "i12",
   "line": "8 common crackers",
   "name": "common crackers",
   "amountText": "8",
   "kind": null
  }
 ],
 "steps": [
  {
   "key": "s1",
   "text": "Order the fish skinned, but head and tail left on. Cut off head and tail and remove fish from backbone. Cut fish in two-inch pieces and set aside. Put head, tail, and backbone broken in pieces, in stewpan; add two cups cold water and bring slowly to boiling-point; cook twenty minutes.",
   "title": "Prepare fish bones",
   "technique": null
  },
  {
   "key": "s2",
   "text": "Cut salt pork in small pieces and try out, add onion, and fry five minutes; strain fat into stewpan.",
   "title": "Cook salt pork and onion",
   "technique": null
  },
  {
   "key": "s3",
   "text": "Parboil potatoes five minutes in boiling water to cover; drain and add potatoes to fat; then add two cups boiling water and cook five minutes.",
   "title": "Cook potatoes",
   "technique": null
  },
  {
   "key": "s4",
   "text": "Add liquor drained from bones, then add the fish; cover, and simmer ten minutes.",
   "title": "Add fish and simmer",
   "technique": null
  },
  {
   "key": "s5",
   "text": "Add milk, salt, pepper, butter, and crackers split and soaked in enough cold milk to moisten, otherwise they will be soft on the outside, but dry on the inside. Pilot bread is sometimes used in place of common crackers.",
   "title": "Finish chowder",
   "technique": null
  }
 ],
 "uses": [
  {
   "ingredientKey": "i1",
   "stepKey": "s1",
   "quote": "fish",
   "amountText": null,
   "functions": [
    "FLAVOR"
   ]
  },
  {
   "ingredientKey": "i6",
   "stepKey": "s2",
   "quote": "onion",
   "amountText": null,
   "functions": [
    "FLAVOR"
   ]
  },
  {
   "ingredientKey": "i7",
   "stepKey": "s2",
   "quote": "salt pork",
   "amountText": null,
   "functions": [
    "FLAVOR",
    "FAT"
   ]
  },
  {
   "ingredientKey": "i2",
   "stepKey": "s3",
   "quote": "potatoes",
   "amountText": null,
   "functions": [
    "STRUCTURE"
   ]
  },
  {
   "ingredientKey": "i4",
   "stepKey": "s3",
   "quote": "potatoes",
   "amountText": null,
   "functions": [
    "STRUCTURE"
   ]
  },
  {
   "ingredientKey": "i11",
   "stepKey": "s4",
   "quote": "milk",
   "amountText": null,
   "functions": [
    "LIQUID"
   ]
  },
  {
   "ingredientKey": "i1",
   "stepKey": "s4",
   "quote": "the fish",
   "amountText": null,
   "functions": [
    "FLAVOR"
   ]
  },
  {
   "ingredientKey": "i8",
   "stepKey": "s5",
   "quote": "salt",
   "amountText": null,
   "functions": [
    "FLAVOR"
   ]
  },
  {
   "ingredientKey": "i9",
   "stepKey": "s5",
   "quote": "pepper",
   "amountText": null,
   "functions": [
    "FLAVOR"
   ]
  },
  {
   "ingredientKey": "i10",
   "stepKey": "s5",
   "quote": "butter",
   "amountText": null,
   "functions": [
    "FAT"
   ]
  },
  {
   "ingredientKey": "i12",
   "stepKey": "s5",
   "quote": "crackers",
   "amountText": null,
   "functions": [
    "STRUCTURE"
   ]
  }
 ],
 "title": "Fish Chowder"
};

/** The same recipe read live by ccmcp-extract-4 on review (2026-10-13, build fbc0282): the same four fragments, the first with a
 *  one-item `options` list (itself). */
export const H01_FISH_CHOWDER_READING_V4 = {
 "recipeFound": true,
 "recipes": [
  {
   "title": "Fish Chowder",
   "titleLineId": "p1.o10"
  }
 ],
 "yield": null,
 "ingredients": [
  {
   "key": "i1",
   "line": "4 lb. cod or haddock",
   "name": "cod",
   "amountText": "4 lb.",
   "kind": null,
   "options": [
    {
     "name": "cod",
     "amountText": "4 lb."
    },
    {
     "name": "haddock",
     "amountText": "4 lb."
    }
   ]
  },
  {
   "key": "i2",
   "line": "6 cups potatoes cut in 1/4-inch",
   "name": "potatoes",
   "amountText": "6 cups",
   "kind": null,
   "options": [
    {
     "name": "potatoes",
     "amountText": "6 cups"
    }
   ]
  },
  {
   "key": "i3",
   "line": "slices, or",
   "name": "slices",
   "amountText": null,
   "kind": null,
   "options": null
  },
  {
   "key": "i4",
   "line": "4 cups potatoes cut in",
   "name": "potatoes",
   "amountText": "4 cups",
   "kind": null,
   "options": null
  },
  {
   "key": "i5",
   "line": "3/4-inch cubes",
   "name": "cubes",
   "amountText": "3/4-inch",
   "kind": null,
   "options": null
  },
  {
   "key": "i6",
   "line": "1 sliced onion",
   "name": "onion",
   "amountText": "1",
   "kind": "onion"
  },
  {
   "key": "i7",
   "line": "1½-inch cube fat salt pork",
   "name": "salt pork",
   "amountText": "1½-inch cube",
   "kind": null
  },
  {
   "key": "i8",
   "line": "1 tablespoon salt",
   "name": "salt",
   "amountText": "1 tablespoon",
   "kind": "salt"
  },
  {
   "key": "i9",
   "line": "1/8 teaspoon pepper",
   "name": "pepper",
   "amountText": "1/8 teaspoon",
   "kind": null
  },
  {
   "key": "i10",
   "line": "3 tablespoons butter",
   "name": "butter",
   "amountText": "3 tablespoons",
   "kind": "unsalted-butter"
  },
  {
   "key": "i11",
   "line": "4 cups scalded milk",
   "name": "milk",
   "amountText": "4 cups",
   "kind": "whole-milk"
  },
  {
   "key": "i12",
   "line": "8 common crackers",
   "name": "crackers",
   "amountText": "8",
   "kind": null
  }
 ],
 "steps": [
  {
   "key": "s1",
   "text": "Order the fish skinned, but head and tail left on. Cut off head and tail and remove fish from backbone. Cut fish in two-inch pieces and set aside. Put head, tail, and backbone broken in pieces, in stewpan; add two cups cold water and bring slowly to boiling-point; cook twenty minutes.",
   "title": "Prepare fish bones",
   "technique": null
  },
  {
   "key": "s2",
   "text": "Cut salt pork in small pieces and try out, add onion, and fry five minutes; strain fat into stewpan.",
   "title": "Cook salt pork and onion",
   "technique": null
  },
  {
   "key": "s3",
   "text": "Parboil potatoes five minutes in boiling water to cover; drain and add potatoes to fat; then add two cups boiling water and cook five minutes.",
   "title": "Cook potatoes",
   "technique": null
  },
  {
   "key": "s4",
   "text": "Add liquor drained from bones, then add the fish; cover, and simmer ten minutes.",
   "title": "Simmer fish",
   "technique": null
  },
  {
   "key": "s5",
   "text": "Add milk, salt, pepper, butter, and crackers split and soaked in enough cold milk to moisten, otherwise they will be soft on the outside, but dry on the inside. Pilot bread is sometimes used in place of common crackers.",
   "title": "Finish chowder",
   "technique": null
  }
 ],
 "uses": [
  {
   "ingredientKey": "i1",
   "stepKey": "s1",
   "quote": "Order the fish",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i1",
   "stepKey": "s4",
   "quote": "the fish",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i7",
   "stepKey": "s2",
   "quote": "Cut salt pork",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i6",
   "stepKey": "s2",
   "quote": "add onion",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i2",
   "stepKey": "s3",
   "quote": "Parboil potatoes",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i4",
   "stepKey": "s3",
   "quote": "Parboil potatoes",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i11",
   "stepKey": "s4",
   "quote": "Add liquor drained from bones",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i11",
   "stepKey": "s5",
   "quote": "Add milk",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i8",
   "stepKey": "s5",
   "quote": "salt",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i9",
   "stepKey": "s5",
   "quote": "pepper",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i10",
   "stepKey": "s5",
   "quote": "butter",
   "amountText": null,
   "functions": []
  },
  {
   "ingredientKey": "i12",
   "stepKey": "s5",
   "quote": "crackers",
   "amountText": null,
   "functions": []
  }
 ],
 "title": "Fish Chowder"
} as const;

/** A second live ccmcp-extract-4 reading on review (2026-10-13, build 285d957) and the swap cards drafted for it at import: the
 *  potato card answers the line as printed ("6 cups or 4 cups" yams). */
export const H01_LIVE_285D957 = {
 "reading": {
  "recipeFound": true,
  "recipes": [
   {
    "title": "Fish Chowder",
    "titleLineId": "p1.o10"
   }
  ],
  "yield": null,
  "ingredients": [
   {
    "key": "i1",
    "line": "4 lb. cod or haddock",
    "name": "cod",
    "amountText": "4 lb.",
    "kind": null,
    "options": [
     {
      "name": "cod",
      "amountText": "4 lb."
     },
     {
      "name": "haddock",
      "amountText": "4 lb."
     }
    ]
   },
   {
    "key": "i2",
    "line": "6 cups potatoes cut in 1/4-inch",
    "name": "potatoes",
    "amountText": "6 cups",
    "kind": null,
    "options": [
     {
      "name": "potatoes",
      "amountText": "6 cups"
     }
    ]
   },
   {
    "key": "i3",
    "line": "slices, or",
    "name": "slices",
    "amountText": null,
    "kind": null,
    "options": null
   },
   {
    "key": "i4",
    "line": "4 cups potatoes cut in",
    "name": "potatoes",
    "amountText": "4 cups",
    "kind": null,
    "options": null
   },
   {
    "key": "i5",
    "line": "3/4-inch cubes",
    "name": "cubes",
    "amountText": "3/4-inch",
    "kind": null,
    "options": null
   },
   {
    "key": "i6",
    "line": "1 sliced onion",
    "name": "onion",
    "amountText": "1",
    "kind": "onion"
   },
   {
    "key": "i7",
    "line": "1½-inch cube fat salt pork",
    "name": "salt pork",
    "amountText": "1½-inch cube",
    "kind": null
   },
   {
    "key": "i8",
    "line": "1 tablespoon salt",
    "name": "salt",
    "amountText": "1 tablespoon",
    "kind": "salt"
   },
   {
    "key": "i9",
    "line": "1/8 teaspoon pepper",
    "name": "pepper",
    "amountText": "1/8 teaspoon",
    "kind": null
   },
   {
    "key": "i10",
    "line": "3 tablespoons butter",
    "name": "butter",
    "amountText": "3 tablespoons",
    "kind": "unsalted-butter"
   },
   {
    "key": "i11",
    "line": "4 cups scalded milk",
    "name": "milk",
    "amountText": "4 cups",
    "kind": "whole-milk"
   },
   {
    "key": "i12",
    "line": "8 common crackers",
    "name": "common crackers",
    "amountText": "8",
    "kind": null
   }
  ],
  "steps": [
   {
    "key": "s1",
    "text": "Order the fish skinned, but head and tail left on. Cut off head and tail and remove fish from backbone. Cut fish in two-inch pieces and set aside. Put head, tail, and backbone broken in pieces, in stewpan; add two cups cold water and bring slowly to boiling-point; cook twenty minutes.",
    "title": "Prepare fish bones",
    "technique": null
   },
   {
    "key": "s2",
    "text": "Cut salt pork in small pieces and try out, add onion, and fry five minutes; strain fat into stewpan.",
    "title": "Cook salt pork and onion",
    "technique": null
   },
   {
    "key": "s3",
    "text": "Parboil potatoes five minutes in boiling water to cover; drain and add potatoes to fat; then add two cups boiling water and cook five minutes.",
    "title": "Cook potatoes",
    "technique": null
   },
   {
    "key": "s4",
    "text": "Add liquor drained from bones, then add the fish; cover, and simmer ten minutes.",
    "title": "Simmer fish",
    "technique": null
   },
   {
    "key": "s5",
    "text": "Add milk, salt, pepper, butter, and crackers split and soaked in enough cold milk to moisten, otherwise they will be soft on the outside, but dry on the inside. Pilot bread is sometimes used in place of common crackers.",
    "title": "Finish chowder",
    "technique": null
   }
  ],
  "uses": [
   {
    "ingredientKey": "i1",
    "stepKey": "s1",
    "quote": "the fish",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i7",
    "stepKey": "s2",
    "quote": "salt pork",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i6",
    "stepKey": "s2",
    "quote": "onion",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i2",
    "stepKey": "s3",
    "quote": "potatoes",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i4",
    "stepKey": "s3",
    "quote": "potatoes",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i1",
    "stepKey": "s4",
    "quote": "the fish",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i11",
    "stepKey": "s5",
    "quote": "milk",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i8",
    "stepKey": "s5",
    "quote": "salt",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i9",
    "stepKey": "s5",
    "quote": "pepper",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i10",
    "stepKey": "s5",
    "quote": "butter",
    "amountText": null,
    "functions": []
   },
   {
    "ingredientKey": "i12",
    "stepKey": "s5",
    "quote": "crackers",
    "amountText": null,
    "functions": []
   }
  ],
  "title": "Fish Chowder"
 },
 "cards": {
  "cards": [
   {
    "useRef": "U1",
    "role": "main protein source",
    "functions": [
     "FLAVOR",
     "STRUCTURE"
    ],
    "verdict": "swap",
    "swap": {
     "ingredient": "haddock",
     "kindId": "unlisted",
     "amountText": "4 lb.",
     "otherIngredients": []
    },
    "stepRewrites": [
     {
      "stepRef": "S1",
      "text": "Order the fish skinned, but head and tail left on. Cut off head and tail and remove fish from backbone. Cut fish in two-inch pieces and set aside. Put head, tail, and backbone broken in pieces, in stewpan; add two cups cold water and bring slowly to boiling-point; cook twenty minutes."
     }
    ],
    "siblings": [
     {
      "useRef": "U5",
      "handling": "coveredBy",
      "note": "The same swap works for both uses."
     }
    ],
    "tradeoff": "Haddock is slightly firmer and milder than cod, which may change the texture and flavor slightly.",
    "opinion": "Use haddock if you run out of cod; it will work well in this chowder."
   },
   {
    "useRef": "U2",
    "role": "adds fat and flavor",
    "functions": [
     "FAT",
     "FLAVOR",
     "BROWNING"
    ],
    "verdict": "swap",
    "swap": {
     "ingredient": "bacon",
     "kindId": "unlisted",
     "amountText": "1½-inch cube",
     "otherIngredients": []
    },
    "stepRewrites": [
     {
      "stepRef": "S2",
      "text": "Cut bacon in small pieces and try out, add onion, and fry five minutes; strain fat into stewpan."
     }
    ],
    "siblings": [],
    "tradeoff": "Bacon will add a smokier flavor than salt pork.",
    "opinion": "Use bacon if you run out of salt pork; it will add a different but still tasty flavor to the chowder."
   },
   {
    "useRef": "U3",
    "role": "adds flavor and structure",
    "functions": [
     "FLAVOR",
     "STRUCTURE"
    ],
    "verdict": "swap",
    "swap": {
     "ingredient": "shallot",
     "kindId": "unlisted",
     "amountText": "1",
     "otherIngredients": []
    },
    "stepRewrites": [
     {
      "stepRef": "S2",
      "text": "Cut shallot in small pieces and try out, add onion, and fry five minutes; strain fat into stewpan."
     }
    ],
    "siblings": [],
    "tradeoff": "Shallots are milder and sweeter than onions, which will change the flavor profile slightly.",
    "opinion": "Use shallots if you run out of onions; they will work well and add a different flavor to the chowder."
   },
   {
    "useRef": "U4",
    "role": "main vegetable component",
    "functions": [
     "STRUCTURE",
     "FLAVOR"
    ],
    "verdict": "swap",
    "swap": {
     "ingredient": "yams",
     "kindId": "unlisted",
     "amountText": "6 cups or 4 cups",
     "otherIngredients": []
    },
    "stepRewrites": [
     {
      "stepRef": "S3",
      "text": "Parboil yams five minutes in boiling water to cover; drain and add yams to fat; then add two cups boiling water and cook five minutes."
     }
    ],
    "siblings": [],
    "tradeoff": "Yams will add a slightly sweeter flavor than potatoes.",
    "opinion": "Use yams if you run out of potatoes; they will work well in this chowder and add a different flavor."
   },
   {
    "useRef": "U5",
    "role": "main protein source",
    "functions": [
     "FLAVOR",
     "STRUCTURE"
    ],
    "verdict": "swap",
    "swap": {
     "ingredient": "haddock",
     "kindId": "unlisted",
     "amountText": "4 lb.",
     "otherIngredients": []
    },
    "stepRewrites": [
     {
      "stepRef": "S4",
      "text": "Add liquor drained from bones, then add the fish; cover, and simmer ten minutes."
     }
    ],
    "siblings": [
     {
      "useRef": "U1",
      "handling": "coveredBy",
      "note": "The same swap works for both uses."
     }
    ],
    "tradeoff": "Haddock is slightly firmer and milder than cod, which may change the texture and flavor slightly.",
    "opinion": "Use haddock if you run out of cod; it will work well in this chowder."
   },
   {
    "useRef": "U6",
    "role": "adds liquid and creaminess",
    "functions": [
     "LIQUID"
    ],
    "verdict": "swap",
    "swap": {
     "ingredient": "heavy cream",
     "kindId": "heavy-cream",
     "amountText": "4 cups",
     "otherIngredients": []
    },
    "stepRewrites": [
     {
      "stepRef": "S5",
      "text": "Add heavy cream, salt, pepper, butter, and crackers split and soaked in enough cold milk to moisten, otherwise they will be soft on the outside, but dry on the inside. Pilot bread is sometimes used in place of common crackers."
     }
    ],
    "siblings": [],
    "tradeoff": "Heavy cream will make the chowder richer and thicker than milk.",
    "opinion": "Use heavy cream if you run out of milk; it will make the chowder richer and thicker."
   },
   {
    "useRef": "U7",
    "role": "adds seasoning",
    "functions": [
     "FLAVOR"
    ],
    "verdict": "omit",
    "swap": null,
    "stepRewrites": [
     {
      "stepRef": "S5",
      "text": "Add milk, pepper, butter, and crackers split and soaked in enough cold milk to moisten, otherwise they will be soft on the outside, but dry on the inside. Pilot bread is sometimes used in place of common crackers."
     }
    ],
    "siblings": [],
    "tradeoff": "Omitting salt will make the chowder less salty, but still edible.",
    "opinion": "If you run out of salt, you can omit it; the chowder will still be edible but less seasoned."
   },
   {
    "useRef": "U8",
    "role": "adds seasoning",
    "functions": [
     "FLAVOR"
    ],
    "verdict": "omit",
    "swap": null,
    "stepRewrites": [
     {
      "stepRef": "S5",
      "text": "Add milk, salt, butter, and crackers split and soaked in enough cold milk to moisten, otherwise they will be soft on the outside, but dry on the inside. Pilot bread is sometimes used in place of common crackers."
     }
    ],
    "siblings": [],
    "tradeoff": "Omitting pepper will make the chowder less spicy, but still edible.",
    "opinion": "If you run out of pepper, you can omit it; the chowder will still be edible but less spicy."
   },
   {
    "useRef": "U9",
    "role": "adds fat and richness",
    "functions": [
     "FAT"
    ],
    "verdict": "swap",
    "swap": {
     "ingredient": "olive oil",
     "kindId": "olive-oil",
     "amountText": "3 tablespoons",
     "otherIngredients": []
    },
    "stepRewrites": [
     {
      "stepRef": "S5",
      "text": "Add milk, salt, pepper, olive oil, and crackers split and soaked in enough cold milk to moisten, otherwise they will be soft on the outside, but dry on the inside. Pilot bread is sometimes used in place of common crackers."
     }
    ],
    "siblings": [],
    "tradeoff": "Olive oil will add a different flavor than butter, but will still add richness.",
    "opinion": "Use olive oil if you run out of butter; it will add a different flavor but still work well in the chowder."
   },
   {
    "useRef": "U10",
    "role": "adds texture and thickens",
    "functions": [
     "STRUCTURE",
     "AERATION"
    ],
    "verdict": "swap",
    "swap": {
     "ingredient": "panko breadcrumbs",
     "kindId": "unlisted",
     "amountText": "8",
     "otherIngredients": []
    },
    "stepRewrites": [
     {
      "stepRef": "S5",
      "text": "Add milk, salt, pepper, butter, and panko breadcrumbs split and soaked in enough cold milk to moisten, otherwise they will be soft on the outside, but dry on the inside. Pilot bread is sometimes used in place of common crackers."
     }
    ],
    "siblings": [],
    "tradeoff": "Panko breadcrumbs will add a coarser texture than crackers.",
    "opinion": "Use panko breadcrumbs if you run out of crackers; they will add a different texture but still work well in the chowder."
   }
  ]
 }
} as const;
