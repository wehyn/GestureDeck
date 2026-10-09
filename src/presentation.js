export class PresentationController {
  #slides;
  #index = 0;

  constructor(slides) {
    if (!Array.isArray(slides) || slides.length === 0) {
      throw new TypeError('A presentation requires at least one slide.');
    }
    this.#slides = slides;
  }

  getSnapshot() {
    return {
      index: this.#index,
      total: this.#slides.length,
      slide: this.#slides[this.#index],
    };
  }

  next() {
    this.#index = Math.min(this.#index + 1, this.#slides.length - 1);
    return this.getSnapshot();
  }

  previous() {
    this.#index = Math.max(this.#index - 1, 0);
    return this.getSnapshot();
  }

  goTo(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#slides.length) {
      throw new RangeError('Slide index is outside the presentation.');
    }
    this.#index = index;
    return this.getSnapshot();
  }
}
