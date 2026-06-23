class Address {
    readonly Country: string;
    readonly City: string;
    readonly Address: string;
    readonly Phone: string;
}

class Logo {
    readonly Width: number;
    readonly Heigth: number;
    readonly Url: URL;
}

export class Entity {
    readonly Name: string;
    readonly Location: Address;
    readonly Logo: Logo;

    constructor() {
    }
}