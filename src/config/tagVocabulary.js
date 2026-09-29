/**
 * The labels the image classifier can put on a photo.
 *
 * CLIP is a zero-shot model: it was never trained on this list. It scores how
 * well an image matches a sentence, so each label is written as a caption
 * ("a photo of a dog") and the classifier picks the captions that fit best.
 * That means the vocabulary is plain data - adding a label is adding a line
 * here, with no retraining. Existing photos keep their old tags until they are
 * re-tagged (bump TAGGER_VERSION in services/imageTagger.js to force that).
 *
 * `key`      what is stored on the asset and matched by search. Stable - a
 *            rename orphans every tag already written.
 * `label`    what the UI shows.
 * `prompt`   the caption CLIP compares against. Phrased the way the photo
 *            would be described on the web, which is what CLIP learned from.
 * `aliases`  other words a person might type for the same thing. Search
 *            matches these against the key, so "puppy" finds dogs even before
 *            the semantic search runs.
 */

const VOCABULARY = [
  // ---- places and nature
  { key: 'beach', label: 'Beach', prompt: 'a photo of a sandy beach by the sea', aliases: ['shore', 'coast', 'seaside'] },
  { key: 'ocean', label: 'Ocean', prompt: 'a photo of the ocean and waves', aliases: ['sea', 'waves'] },
  { key: 'mountain', label: 'Mountains', prompt: 'a photo of mountains', aliases: ['mountains', 'hills', 'peak', 'hiking'] },
  { key: 'forest', label: 'Forest', prompt: 'a photo of a forest with trees', aliases: ['woods', 'trees', 'jungle'] },
  { key: 'desert', label: 'Desert', prompt: 'a photo of a desert with sand dunes', aliases: ['dunes', 'sand'] },
  { key: 'lake', label: 'Lake', prompt: 'a photo of a lake', aliases: ['pond'] },
  { key: 'river', label: 'River', prompt: 'a photo of a river', aliases: ['stream', 'creek'] },
  { key: 'waterfall', label: 'Waterfall', prompt: 'a photo of a waterfall', aliases: [] },
  { key: 'snow', label: 'Snow', prompt: 'a photo of a snowy winter landscape', aliases: ['winter', 'ice'] },
  { key: 'sunset', label: 'Sunset', prompt: 'a photo of a sunset or sunrise sky', aliases: ['sunrise', 'dusk', 'golden hour'] },
  { key: 'night-sky', label: 'Night sky', prompt: 'a photo of the night sky full of stars', aliases: ['stars', 'starry', 'night'] },
  { key: 'space', label: 'Space', prompt: 'an image of outer space, a galaxy or nebula', aliases: ['galaxy', 'nebula', 'cosmos', 'universe', 'planet'] },
  { key: 'sky', label: 'Sky and clouds', prompt: 'a photo of a blue sky with clouds', aliases: ['clouds', 'cloud'] },
  { key: 'field', label: 'Countryside', prompt: 'a photo of green fields in the countryside', aliases: ['farm', 'meadow', 'grass'] },
  { key: 'garden', label: 'Garden', prompt: 'a photo of a garden or park', aliases: ['park'] },
  { key: 'flowers', label: 'Flowers', prompt: 'a photo of flowers', aliases: ['flower', 'bloom', 'roses'] },
  { key: 'plant', label: 'Plants', prompt: 'a photo of plants and leaves', aliases: ['plants', 'leaves', 'leaf'] },

  // ---- built environment
  { key: 'city', label: 'City', prompt: 'a photo of a city skyline with tall buildings', aliases: ['skyline', 'urban', 'downtown', 'skyscraper'] },
  { key: 'street', label: 'Street', prompt: 'a photo of a city street', aliases: ['road', 'traffic'] },
  { key: 'city-night', label: 'City at night', prompt: 'a photo of a city at night with neon lights', aliases: ['neon', 'night city'] },
  { key: 'building', label: 'Architecture', prompt: 'a photo of a building, architecture', aliases: ['architecture', 'house', 'buildings'] },
  { key: 'indoor', label: 'Indoors', prompt: 'a photo of a room indoors', aliases: ['room', 'interior', 'home'] },
  { key: 'bridge', label: 'Bridge', prompt: 'a photo of a bridge', aliases: [] },

  // ---- people
  { key: 'person', label: 'Person', prompt: 'a photo of a person', aliases: ['people', 'human', 'man', 'woman', 'girl', 'boy'] },
  { key: 'portrait', label: 'Portrait', prompt: 'a close-up portrait of a face', aliases: ['face', 'headshot'] },
  { key: 'selfie', label: 'Selfie', prompt: 'a selfie taken with a phone', aliases: [] },
  { key: 'group', label: 'Group', prompt: 'a photo of a group of people', aliases: ['friends', 'family', 'crowd'] },
  { key: 'child', label: 'Kids', prompt: 'a photo of a child', aliases: ['kid', 'kids', 'baby', 'children'] },
  { key: 'party', label: 'Party', prompt: 'a photo of a party or celebration', aliases: ['celebration', 'birthday', 'wedding'] },
  { key: 'concert', label: 'Concert', prompt: 'a photo of a concert or live music', aliases: ['music', 'gig', 'stage'] },
  { key: 'sport', label: 'Sport', prompt: 'a photo of people playing sport', aliases: ['sports', 'football', 'cricket', 'game'] },

  // ---- animals
  { key: 'dog', label: 'Dog', prompt: 'a photo of a dog', aliases: ['dogs', 'puppy', 'pet'] },
  { key: 'cat', label: 'Cat', prompt: 'a photo of a cat', aliases: ['cats', 'kitten', 'pet'] },
  { key: 'bird', label: 'Bird', prompt: 'a photo of a bird', aliases: ['birds'] },
  { key: 'animal', label: 'Wildlife', prompt: 'a photo of a wild animal', aliases: ['animals', 'wildlife', 'zoo'] },

  // ---- food
  { key: 'food', label: 'Food', prompt: 'a photo of food on a plate', aliases: ['meal', 'dinner', 'lunch', 'breakfast'] },
  { key: 'dessert', label: 'Dessert', prompt: 'a photo of a cake or dessert', aliases: ['cake', 'sweets', 'ice cream'] },
  { key: 'drink', label: 'Drinks', prompt: 'a photo of coffee or a drink', aliases: ['coffee', 'tea', 'juice', 'cocktail'] },
  { key: 'fruit', label: 'Fruit', prompt: 'a photo of fruit', aliases: ['fruits', 'lemon', 'apple', 'orange'] },

  // ---- things
  { key: 'car', label: 'Car', prompt: 'a photo of a car', aliases: ['cars', 'vehicle'] },
  { key: 'bike', label: 'Bike', prompt: 'a photo of a bicycle or motorcycle', aliases: ['bicycle', 'motorcycle', 'motorbike'] },
  { key: 'train', label: 'Train', prompt: 'a photo of a train', aliases: ['railway'] },
  { key: 'airplane', label: 'Airplane', prompt: 'a photo of an airplane', aliases: ['plane', 'flight', 'aircraft'] },
  { key: 'boat', label: 'Boat', prompt: 'a photo of a boat or ship', aliases: ['ship'] },
  { key: 'statue', label: 'Statue', prompt: 'a photo of a statue or sculpture', aliases: ['sculpture'] },

  // ---- images that are not photographs
  { key: 'anime', label: 'Anime', prompt: 'an anime illustration', aliases: ['manga'] },
  { key: 'illustration', label: 'Illustration', prompt: 'a digital illustration or painting', aliases: ['drawing', 'painting', 'artwork', 'art'] },
  { key: 'render', label: '3D render', prompt: 'a 3D render', aliases: ['cgi', '3d'] },
  { key: 'poster', label: 'Poster', prompt: 'a movie poster', aliases: ['cover'] },
  { key: 'screenshot', label: 'Screenshot', prompt: 'a screenshot of a phone or computer screen', aliases: ['screen'] },
  { key: 'document', label: 'Document', prompt: 'a scan of a text document', aliases: ['text', 'receipt', 'paper', 'notes'] },
  { key: 'test-pattern', label: 'Test pattern', prompt: 'a TV test pattern with colour bars', aliases: ['colour bars', 'color bars'] },

  // ---- look
  { key: 'black-and-white', label: 'Black and white', prompt: 'a black and white photo', aliases: ['monochrome', 'grayscale', 'greyscale', 'b&w'] },
];

module.exports = { VOCABULARY };
