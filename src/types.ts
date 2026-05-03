export interface Family {
  id: string;
  name: string;
  description?: string;
  creatorId: string;
  createdAt: any;
}

export interface Member {
  id: string;
  familyId: string;
  name: string;
  gender: 'male' | 'female' | 'other';
  fatherId?: string;
  motherId?: string;
  birthDate?: string;
  deathDate?: string;
  phoneNumber?: string;
  photoURL?: string;
  wifeId?: string;
  address?: string;
  creatorId: string;
  displayOrder?: number;
  serialNumber?: string;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  role: 'admin' | 'user';
}
