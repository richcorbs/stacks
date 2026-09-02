export class SuperthreadRequestGate {
  private generation = 0;
  private detailRequest = 0;

  beginGeneration() {
    this.generation += 1;
    this.detailRequest += 1;
    return this.generation;
  }

  isCurrentGeneration(generation: number) {
    return generation === this.generation;
  }

  beginDetailRequest() {
    this.detailRequest += 1;
    return this.detailRequest;
  }

  invalidateDetailRequest() {
    this.detailRequest += 1;
  }

  isCurrentDetailRequest(request: number) {
    return request === this.detailRequest;
  }

  currentGeneration() {
    return this.generation;
  }
}
