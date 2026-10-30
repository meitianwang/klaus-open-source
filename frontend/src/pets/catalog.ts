import { BUILT_IN_PETS as catalog } from "../../../contracts/desktop-pet-builtins";
export const BUILT_IN_PETS = catalog.map((pet) => ({
  ...pet,
  spritesheetUrl: new URL(`.${pet.spritesheetUrl}`, document.baseURI).href,
}));
