# Jikkan

A private, real-time chat for two people, designed so that many pairs or groups could use it later.

## Language

**Room**:
A private conversation. Today exactly one Room exists, but nothing assumes that.

**Member**:
A person who belongs to a Room and can read and write in it.

**Message**:
One text a Member sent in a Room. Kept permanently.

**Display name**:
The short name a Member goes by in chat, such as "Girish" or "Nikya".

**Alias**:
Another name a Member is known by, such as "Girya" or "Nikku". A Member has a Display name and any number of Aliases.

**Account**:
A person's sign-in. A Member is an Account that belongs to a Room. Account-wide settings, such as notifications on or off, belong to the Account, not to a device.

**Media**:
A photo, video or voice note attached to a Message. Stored privately and shown through short-lived links. When storage runs low, the oldest Media is deleted first and its Message keeps a note saying so.

## Relationships

- A **Room** has one or more **Members**; a **Member** is an **Account** in a **Room**.
- A **Message** belongs to exactly one **Room** and was sent by one **Member**.
- An **Account** can only read the **Rooms** it is a **Member** of.
- Sign-up is closed: **Accounts** are created by the owner, not by visitors.
- A **Message** has at most one **Media**; **Media** belongs to the **Room** its Message was sent in.
