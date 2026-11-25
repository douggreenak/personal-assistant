import Contacts

/// Turns phone numbers and email addresses from Messages into names, so the assistant sees "Sam Rivera (+1907…)"
/// instead of a bare number. The address book is read on this Mac only; names are sent only as part of the sender field.
final class ContactsResolver {
    private var byPhone: [String: String] = [:], byEmail: [String: String] = [:]

    static func requestAccess() async -> Bool { (try? await CNContactStore().requestAccess(for: .contacts)) ?? false }
    static var authorized: Bool { CNContactStore.authorizationStatus(for: .contacts) == .authorized }

    /// Last 10 digits, so +1 (907) 555-0100 and 9075550100 match.
    static func digits(_ s: String) -> String { String(s.filter(\.isNumber).suffix(10)) }

    func reload() throws {
        let store = CNContactStore()
        let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey, CNContactPhoneNumbersKey, CNContactEmailAddressesKey] as [CNKeyDescriptor]
        var phones: [String: String] = [:], emails: [String: String] = [:]
        try store.enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { c, _ in
            var name = [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")
            if name.isEmpty { name = c.nickname.isEmpty ? c.organizationName : c.nickname }
            guard !name.isEmpty else { return }
            for p in c.phoneNumbers { let d = Self.digits(p.value.stringValue); if d.count >= 7 { phones[d] = name } }
            for e in c.emailAddresses { emails[(e.value as String).lowercased()] = name }
        }
        byPhone = phones; byEmail = emails
    }

    func name(for handle: String) -> String? {
        handle.contains("@") ? byEmail[handle.lowercased()] : byPhone[Self.digits(handle)]
    }
}
